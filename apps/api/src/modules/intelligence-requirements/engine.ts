import { hashJson as hash } from '../../core/json';
import type { IntelligenceRegistry } from './registry';
import { intelligenceRegistry } from './registry';

export interface ContextMention {
  id: string; documentId: string; evidenceRecordId: string | null;
  mentionType: string; text: string; normalizedText: string | null;
  pageNumber: number | null; startOffset: number | null; endOffset: number | null;
}
export interface CaseContext {
  caseId: string;
  metadata: string;
  documents: { id: string; contentHash: string; pages: { pageNumber: number; text: string }[] }[];
  mentions: ContextMention[];
}
export interface GapCandidate {
  caseType: string; ruleId: string; fingerprint: string; contextHash: string;
  requiredData: string; targetType: string; targetEntity: string; sourceId: string;
  timeFrom: Date; timeTo: Date; purpose: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW'; priorityReason: string; explanation: string;
  origins: ContextMention[];
}
export { hash };

export function parseMentionDate(raw: string): Date | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(raw);
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const textual = /^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i.exec(raw);
  const [y, m, d] = iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])] : numeric
    ? [Number(numeric[3]), Number(numeric[2]), Number(numeric[1])] : textual
      ? [Number(textual[3]), months.indexOf(textual[2].toLowerCase()) + 1, Number(textual[1])] : [0,0,0];
  if (y < 1900 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}

function localText(context: CaseContext, mention: ContextMention): string {
  const text = context.documents.find(d => d.id === mention.documentId)?.pages.find(p => p.pageNumber === mention.pageNumber)?.text;
  if (!text || mention.startOffset === null || mention.endOffset === null || text.slice(mention.startOffset, mention.endOffset) !== mention.text) return '';
  const before = text.slice(0, mention.startOffset);
  const after = text.slice(mention.endOffset);
  // A period before a numeric identifier ("account no. 123...") is not a sentence boundary.
  const boundaries = [...before.matchAll(/[.!?]\s+(?=[A-Z])|[;\n]/g)];
  const last = boundaries.at(-1);
  const start = last ? last.index! + last[0].length : 0;
  const end = after.search(/[.!?]\s+(?=[A-Z])|[;\n]/);
  return text.slice(start, end < 0 ? text.length : mention.endOffset + end).trim();
}

export function analyzeContext(context: CaseContext, registry: IntelligenceRegistry = intelligenceRegistry) {
  const stableMentions = context.mentions.map(m => ({ documentId: m.documentId, evidenceRecordId: m.evidenceRecordId,
    mentionType: m.mentionType, text: m.text, normalizedText: m.normalizedText, pageNumber: m.pageNumber,
    startOffset: m.startOffset, endOffset: m.endOffset })).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const contextHash = hash({ metadata: context.metadata, documents: context.documents, mentions: stableMentions, registry });
  const texts = [{ origin: 'case_metadata', text: context.metadata }, ...context.documents.flatMap(d => d.pages.map(p => ({ origin: `${d.id}:page:${p.pageNumber}`, text: p.text })))];
  const matches = registry.caseTypes.map(rule => ({
    rule,
    signals: texts.flatMap(t => rule.signals.filter(s => new RegExp(s, 'i').test(t.text)).map(signal => ({ origin: t.origin, signal }))),
  })).filter(m => m.signals.length > 0);
  const caseType = matches.length === 1 ? matches[0].rule.id : matches.length > 1 ? 'MIXED' : 'UNKNOWN';
  const gaps: GapCandidate[] = [];
  const excluded: { ruleId: string; reason: string }[] = [];
  for (const { rule: type } of matches) {
    for (const rule of type.requirements) {
      if (!registry.sources.some(s => s.id === rule.sourceId)) throw new Error(`Unregistered source: ${rule.sourceId}`);
      const targets = context.mentions.filter(m => m.mentionType === rule.targetType &&
        (!rule.targetPattern || new RegExp(rule.targetPattern, 'i').test(m.text)) &&
        new RegExp(rule.targetContext, 'i').test(localText(context, m)));
      if (!targets.length) excluded.push({ ruleId: rule.id, reason: 'No target with a supporting local investigative context.' });
      for (const target of targets) {
        // Only an explicit incident date/window in this same source document can scope a request.
        // Filing dates, birth dates and unrelated dates are never silently used.
        const dates = context.mentions.filter(m => m.documentId === target.documentId && m.mentionType === 'date' &&
          /\b(incident|offence|offense|transaction|payment)\s*(date|window|period|occurred)?\s*:/i.test(localText(context, m)))
          .sort((a,b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0) || (a.startOffset ?? 0) - (b.startOffset ?? 0));
        const parsed = dates.map(m => ({ mention: m, date: parseMentionDate(m.normalizedText ?? m.text) }));
        if (!parsed.length || parsed.some(p => !p.date)) {
          excluded.push({ ruleId: rule.id, reason: 'Missing or invalid explicit incident/transaction date window.' }); continue;
        }
        const sorted = parsed.map(p => p.date!.getTime()).sort((a,b) => a-b);
        if (parsed.some((p,i) => i > 0 && p.date! < parsed[i-1].date!)) {
          excluded.push({ ruleId: rule.id, reason: 'Reversed or conflicting explicit date window.' }); continue;
        }
        const timeFrom = new Date(sorted[0]);
        const timeTo = new Date(sorted[sorted.length - 1] + 86_400_000 - 1);
        if ((timeTo.getTime() - timeFrom.getTime() + 1) / 86_400_000 > rule.maxDays || sorted[sorted.length - 1] > Date.now()) {
          excluded.push({ ruleId: rule.id, reason: 'Date window exceeds source scope or starts in the future.' }); continue;
        }
        const targetEntity = target.normalizedText ?? target.text;
        const fingerprint = hash({ contextHash, rule: rule.id, caseType: type.id, source: rule.sourceId, data: rule.requiredData,
          purpose: rule.purpose, targetEntity: targetEntity.toLowerCase(), timeFrom, timeTo });
        const origins = [target, ...dates];
        const existing = gaps.find(g => g.fingerprint === fingerprint);
        if (existing) { existing.origins.push(...origins.filter(o => !existing.origins.some(e => e.id === o.id))); continue; }
        gaps.push({ caseType: type.id, ruleId: rule.id, fingerprint, contextHash,
          requiredData: rule.requiredData, targetType: target.mentionType, targetEntity, sourceId: rule.sourceId,
          timeFrom, timeTo, purpose: rule.purpose, priority: rule.priority, priorityReason: rule.priorityReason,
          explanation: `Rule ${rule.id} applies to ${type.id}. Source context: "${localText(context, target)}". Target "${target.text}" is linked to the explicit incident/transaction window ${timeFrom.toISOString()} through ${timeTo.toISOString()}. ${rule.purpose} Priority: ${rule.priorityReason}`,
          origins });
      }
    }
  }
  return { caseType, contextHash, registryVersion: registry.version,
    rationale: { matches: matches.map(m => ({ caseType: m.rule.id, signals: m.signals })), excluded,
      limitation: 'Rule-based suggestions from reported context, not findings of fact or guilt.' }, gaps };
}
