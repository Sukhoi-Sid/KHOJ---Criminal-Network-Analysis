import type { Prisma, Mention } from '@prisma/client';
import { ENTITY_TYPES, MentionType, type EntityType } from '@sih/shared';
import { hashJson as stableDigest, toJson } from '../../core/json';
import { ValidationError } from '../../core/errors';
import { evidenceStoreService } from '../evidence-store/evidence.service';
import { parseMentionDate } from '../intelligence-requirements/engine';
import { normalizeIdentifiers, valueNormalizers } from './normalization';
import { returnedDataNormalizers } from './source-normalizers';
import { RESOLUTION_RULES } from './resolvers';

export { stableDigest, toJson };
type RecordInput = Omit<Prisma.NormalizedSourceRecordUncheckedCreateInput, 'id' | 'createdAt' | 'updatedAt'>;

function personIdentifiers(person: Mention, mentions: Mention[], pages: unknown) {
  const page = (pages as { pageNumber: number; text: string }[] | null)?.find(p => p.pageNumber === person.pageNumber);
  if (!page || person.startOffset === null || person.endOffset === null) return {};
  // Associate only an explicit labeled subject block. Never borrow all phones from a page/FIR.
  const before = page.text.slice(0,person.startOffset);
  const lineStart = before.lastIndexOf('\n') + 1;
  if (!/^(?:Complainant|Accused|Witness|Victim|Informant)\s*:/i.test(page.text.slice(lineStart,person.startOffset))) return {};
  const tail = page.text.slice(person.endOffset);
  const firstEnd = tail.indexOf('\n');
  if (firstEnd < 0) return {};
  const fieldStart = person.endOffset + firstEnd + 1;
  let end = fieldStart;
  for (const line of page.text.slice(fieldStart).split('\n')) {
    if (!/^(?:Phone|Mobile|DOB|Date of birth|Address|Account|Vehicle|Organization)\s*:/i.test(line)) break;
    end += line.length + 1;
  }
  const ids: Record<string,string[]> = {};
  for (const m of mentions) {
    if (m.documentId !== person.documentId || m.pageNumber !== person.pageNumber || m.startOffset === null || m.startOffset < fieldStart || m.startOffset >= end) continue;
    const prefix = page.text.slice(page.text.lastIndexOf('\n',m.startOffset) + 1,m.startOffset);
    let field: string | undefined;
    if (m.mentionType === 'phone' && /^(Phone|Mobile)\s*:/i.test(prefix)) field = 'phone';
    if (m.mentionType === 'date' && /^(DOB|Date of birth)\s*:/i.test(prefix)) field = 'dob';
    if (m.mentionType === 'location' && /^Address\s*:/i.test(prefix)) field = 'address';
    if (m.mentionType === 'vehicle' && /^Vehicle\s*:/i.test(prefix)) field = 'vehicle';
    if (m.mentionType === 'money' && /^Account\s*:/i.test(prefix)) field = 'account';
    if (m.mentionType === 'organization' && /^Organization\s*:/i.test(prefix)) field = 'organization';
    if (!field) continue;
    const v = field === 'dob' ? parseMentionDate(m.normalizedText ?? m.text)?.toISOString().slice(0,10) : m.text;
    if (v) (ids[field] ??= []).push(v);
  }
  return normalizeIdentifiers(ids);
}

export async function collectSourceRecords(tx: Prisma.TransactionClient, caseId: string): Promise<RecordInput[]> {
  const kase = await tx.case.findUniqueOrThrow({ where: { id: caseId } });
  const mentions = await tx.mention.findMany({ where: { caseId, document: { processingStatus: 'completed', sourceType: { not: 'external_package' } } },
    include: { document: true, evidenceRecord: true }, orderBy: [{ documentId: 'asc' },{ startOffset: 'asc' },{ id: 'asc' }] });
  const inputs: RecordInput[] = [];
  for (const m of mentions) {
    if (!(ENTITY_TYPES as readonly string[]).includes(m.mentionType)) continue;
    const entityType = m.mentionType as EntityType;
    const normalized = valueNormalizers[entityType](m.text);
    if (entityType === MentionType.MONEY && !normalized.validIdentifier) continue; // monetary amounts are not identities
    const identifiers = entityType === MentionType.PERSON ? personIdentifiers(m,mentions,m.document.extractedPages) : {};
    const sourceLocation = { pageNumber: m.pageNumber, startOffset: m.startOffset, endOffset: m.endOffset,
      mentionType: m.mentionType, originalMentionId: m.id, contentHash: m.document.contentHash };
    const sourceKey = stableDigest({ kind: 'mention', documentId: m.documentId, hash: m.document.contentHash,
      type: entityType, page: m.pageNumber, start: m.startOffset, end: m.endOffset, raw: m.text, identifiers,
      confidence: m.confidence, version: RESOLUTION_RULES.version });
    inputs.push({ caseId, sourceKey, entityType, rawValue: m.text, normalizedValue: normalized.value, validIdentifier: normalized.validIdentifier,
      sourceKind: 'MENTION', documentId: m.documentId, evidenceRecordId: m.evidenceRecordId, mentionId: m.id,
      sourceTimestamp: m.extractedAt, confidence: m.confidence, reliabilityTier: m.evidenceRecord?.reliabilityTier ?? 'tier3_derived',
      attributes: toJson({ extractionMethod: m.extractionMethod }), identifiers: toJson(identifiers), sourceLocation: toJson(sourceLocation) });
  }
  const responses = await tx.intelligenceResponse.findMany({ where: { request: { caseId, status: { in: ['RECEIVED','COMPLETED'] } } },
    include: { request: { include: { source: true, authorization: true } }, evidenceRecord: { include: { document: true, provenance: true } } }, orderBy: { id: 'asc' } });
  for (const response of responses) {
    if (!response.request.authorization?.approved || response.evidenceRecord.caseId !== caseId) throw new ValidationError('Unapproved or mismatched source package');
    const payload = await evidenceStoreService.readExternalPackage(response.evidenceRecord) as Record<string,unknown>;
    if (payload.caseId !== caseId || payload.requestId !== response.requestId || payload.sourceId !== response.request.sourceId || !Array.isArray(payload.records)) throw new ValidationError('Source package scope mismatch');
    const normalizer = returnedDataNormalizers.get(response.request.source.category);
    if (!normalizer) throw new ValidationError('No entity normalizer registered for source category');
    for (const [index, row] of payload.records.entries()) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new ValidationError('Invalid source record');
      for (const extracted of normalizer.normalize(row as Record<string,unknown>)) {
        const normalized = valueNormalizers[extracted.entityType](extracted.rawValue);
        inputs.push({ caseId, sourceKey: stableDigest({ kind: 'package', responseId: response.id, hash: response.evidenceRecord.contentHash,
          index, field: extracted.field, version: RESOLUTION_RULES.version }), entityType: extracted.entityType,
          rawValue: extracted.rawValue, normalizedValue: normalized.value, validIdentifier: normalized.validIdentifier,
          sourceKind: 'RETURNED_INTELLIGENCE', sourceId: response.request.sourceId, department: response.request.source.department,
          documentId: response.evidenceRecord.documentId, evidenceRecordId: response.evidenceRecordId, responseId: response.id,
          sourceTimestamp: response.retrievedAt, confidence: 1, reliabilityTier: response.evidenceRecord.reliabilityTier,
          identifiers: toJson(extracted.identifiers), attributes: toJson(extracted.attributes), sourceLocation: toJson({
            jsonPointer: `/records/${index}/${extracted.field}`, requestId: response.requestId, responseId: response.id,
            contentHash: response.evidenceRecord.contentHash, synthetic: payload.synthetic === true,
            confidenceMeaning: 'Exact transcription of structured source, not confidence in its truth',
          }) });
      }
    }
  }
  inputs.push({ caseId, sourceKey: stableDigest({ kind: 'case', caseId, ref: kase.caseId }), entityType: MentionType.CASE_IDENTIFIER,
    rawValue: kase.caseId, normalizedValue: kase.caseId.toUpperCase(), validIdentifier: true, sourceKind: 'CASE_METADATA',
    confidence: 1, reliabilityTier: 'tier3_derived', attributes: {}, identifiers: {}, sourceTimestamp: kase.createdAt,
    sourceLocation: { field: 'case.caseId', caseId } });
  if (inputs.length > RESOLUTION_RULES.maxRecords) throw new ValidationError('Case exceeds the MVP normalized-record limit');
  return inputs;
}
