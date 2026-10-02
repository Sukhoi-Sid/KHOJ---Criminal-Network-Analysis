import { Prisma, type IntelligenceRequestStatus } from '@prisma/client';
import { AuditAction, AuditResourceType, Permission } from '@sih/shared';
import { prisma } from '../../core/db';
import { eventBus } from '../../core/domain-events';
import { ForbiddenError, NotFoundError, ValidationError } from '../../core/errors';
import { auditService } from '../audit/audit.service';
import { assertCasePermission, assertSourceAccess, auditAccessDenied, canUseSource, type CaseActor } from '../auth/policies';
import { getDocumentProcessor, type ExtractedPage } from '../document-intelligence/processors';
import { evidenceStoreService } from '../evidence-store/evidence.service';
import { exchangeSynthetic, type RequestScope } from '../data-exchange/adapters';
import { analyzeContext, type CaseContext } from './engine';
import { intelligenceRegistry } from './registry';
import { IntelligenceEvents as Events } from './events';

export type IntelligenceActor = CaseActor;
import { toJson as json } from '../../core/json';
const gapInclude = { source: true, origins: true } as const;
const requestInclude = { source: true, authorization: true, response: { include: { evidenceRecord: { include: { provenance: true } } } }, transitions: { orderBy: { sequence: 'asc' as const } } } as const;

export class IntelligenceService {
  /** Uses the existing ABAC primitive, masking existence consistently for Phase 3. */
  async access(caseId: string, actor: IntelligenceActor, permission: Permission) {
    await assertCasePermission(caseId, actor, permission);
  }

  private async denied(actor: IntelligenceActor) {
    await auditAccessDenied(actor);
  }

  private async sourceAccess(sourceId: string, actor: IntelligenceActor) {
    await assertSourceAccess(sourceId, actor);
  }

  private canUseSource(sourceId: string, actor: IntelligenceActor) {
    return canUseSource(sourceId, actor);
  }

  private async locked<T>(caseId: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async tx => {
      // Serialize generation and request transitions per case, including simultaneous retries.
      await tx.$queryRaw`SELECT id FROM cases WHERE id = ${caseId} FOR UPDATE`;
      return work(tx);
    }, { timeout: 20_000, maxWait: 20_000 });
  }

  private async audit(tx: Prisma.TransactionClient, caseId: string, actor: IntelligenceActor, action: AuditAction, resourceId: string, metadata: Record<string, unknown> = {}) {
    await auditService.emit({ actorId: actor.id, actorEmail: actor.email, action,
      resourceType: action === AuditAction.INTELLIGENCE_REVIEW || action === AuditAction.INTELLIGENCE_ANALYZE ? AuditResourceType.INTELLIGENCE_GAP : AuditResourceType.INTELLIGENCE_REQUEST,
      resourceId, caseId, metadata, ipAddress: actor.ipAddress }, tx);
  }

  private async loadContext(tx: Prisma.TransactionClient, caseId: string): Promise<CaseContext> {
    const kase = await tx.case.findUniqueOrThrow({ where: { id: caseId } });
    const documents = await tx.document.findMany({ where: { caseId, processingStatus: 'completed', sourceType: { not: 'external_package' } }, orderBy: { id: 'asc' } });
    const docs: CaseContext['documents'] = [];
    for (const doc of documents) {
      let pages = doc.extractedPages as unknown as ExtractedPage[] | null;
      if (!pages) {
        // Backfill old Phase 2 documents with the SAME processor; no new mention extraction.
        pages = (await getDocumentProcessor(doc.mimeType).extract({ documentId: doc.id, caseId, blobPath: doc.blobPath, mimeType: doc.mimeType })).pages;
        await tx.document.update({ where: { id: doc.id }, data: { extractedPages: json(pages) } });
      }
      docs.push({ id: doc.id, contentHash: doc.contentHash, pages });
    }
    const mentions = await tx.mention.findMany({ where: { caseId, documentId: { in: documents.map(d => d.id) } }, orderBy: [{ documentId: 'asc' }, { startOffset: 'asc' }] });
    return { caseId, metadata: [kase.title, kase.description, kase.contextSummary].filter(Boolean).join('\n'), documents: docs, mentions };
  }

  async analyze(caseId: string, actor: IntelligenceActor) {
    await this.access(caseId, actor, Permission.INTELLIGENCE_WRITE);
    const result = await this.locked(caseId, async tx => {
      const analysis = analyzeContext(await this.loadContext(tx, caseId));
      for (const source of intelligenceRegistry.sources) await tx.intelligenceSource.upsert({ where: { id: source.id }, create: source, update: source });
      const prior = await tx.caseContextAnalysis.findUnique({ where: { caseId } });
      const context = await tx.caseContextAnalysis.upsert({ where: { caseId },
        create: { caseId, caseType: analysis.caseType, contextHash: analysis.contextHash, registryVersion: analysis.registryVersion, rationale: json(analysis.rationale) },
        update: prior?.contextHash === analysis.contextHash ? {} : { caseType: analysis.caseType, contextHash: analysis.contextHash, registryVersion: analysis.registryVersion, rationale: json(analysis.rationale) } });
      await tx.intelligenceGap.updateMany({ where: { caseId, fingerprint: { notIn: analysis.gaps.map(g => g.fingerprint) }, status: { in: ['OPEN','REVIEWED','DISMISSED'] } }, data: { status: 'STALE' } });
      const generated: string[] = [];
      for (const candidate of analysis.gaps) {
        if (!this.canUseSource(candidate.sourceId, actor)) continue;
        const { origins, ...data } = candidate;
        const previous = await tx.intelligenceGap.findUnique({ where: { caseId_fingerprint: { caseId, fingerprint: data.fingerprint } } });
        if (previous) {
          // An immutable request never silently inherits changed context or a different scope.
          if ((previous.contextHash !== data.contextHash || previous.status === 'STALE') && !['REQUESTED','RESOLVED'].includes(previous.status)) {
            await tx.intelligenceGap.update({ where: { id: previous.id }, data: { ...data, status: 'OPEN', reviewedById: null, reviewedAt: null, reviewNote: null,
              origins: { deleteMany: {}, create: origins.map(m => ({ documentId: m.documentId, evidenceRecordId: m.evidenceRecordId, mentionId: m.id, snapshot: json(m) })) } } });
          }
          continue;
        }
        const gap = await tx.intelligenceGap.create({ data: { ...data, caseId,
          origins: { create: origins.map(m => ({ documentId: m.documentId, evidenceRecordId: m.evidenceRecordId, mentionId: m.id, snapshot: json(m) })) } } });
        generated.push(gap.id);
      }
      await this.audit(tx, caseId, actor, AuditAction.INTELLIGENCE_ANALYZE, context.id, { generated: generated.length, caseType: context.caseType });
      const gaps = await tx.intelligenceGap.findMany({ where: { caseId }, include: gapInclude, orderBy: { createdAt: 'asc' } });
      return { context, generated, gaps: gaps.filter(g => this.canUseSource(g.sourceId, actor)) };
    });
    for (const gapId of result.generated) await eventBus.publish({ id: gapId, type: Events.GAP_GENERATED, payload: { caseId, gapId }, timestamp: Date.now() });
    return result;
  }

  async getContext(caseId: string, actor: IntelligenceActor) {
    await this.access(caseId, actor, Permission.INTELLIGENCE_READ);
    const context = await prisma.caseContextAnalysis.findUnique({ where: { caseId } });
    await this.audit(prisma, caseId, actor, AuditAction.INTELLIGENCE_READ, caseId, { view: 'context' });
    return context;
  }

  async listGaps(caseId: string, actor: IntelligenceActor) {
    await this.access(caseId, actor, Permission.INTELLIGENCE_READ);
    const items = await prisma.intelligenceGap.findMany({ where: { caseId }, include: gapInclude, orderBy: { createdAt: 'asc' } });
    await this.audit(prisma, caseId, actor, AuditAction.INTELLIGENCE_READ, caseId, { view: 'gaps' });
    return items.filter(g => this.canUseSource(g.sourceId, actor));
  }

  private async gap(tx: Prisma.TransactionClient, caseId: string, gapId: string, actor: IntelligenceActor) {
    const gap = await tx.intelligenceGap.findFirst({ where: { id: gapId, caseId }, include: gapInclude });
    if (!gap) throw new NotFoundError('Intelligence gap not found');
    await this.sourceAccess(gap.sourceId, actor);
    return gap;
  }

  async getGap(caseId: string, gapId: string, actor: IntelligenceActor) {
    await this.access(caseId, actor, Permission.INTELLIGENCE_READ);
    const gap = await this.gap(prisma, caseId, gapId, actor);
    await this.audit(prisma, caseId, actor, AuditAction.INTELLIGENCE_READ, gapId);
    return gap;
  }

  private async assertCurrent(tx: Prisma.TransactionClient, caseId: string, gap: { fingerprint: string; contextHash: string }) {
    const analysis = analyzeContext(await this.loadContext(tx, caseId));
    if (analysis.contextHash !== gap.contextHash || !analysis.gaps.some(g => g.fingerprint === gap.fingerprint)) {
      throw new ValidationError('Case context changed. Regenerate gaps and review the current requirement.');
    }
  }

  async review(caseId: string, gapId: string, actor: IntelligenceActor, decision: 'select' | 'dismiss', note: string) {
    await this.access(caseId, actor, Permission.INTELLIGENCE_WRITE);
    return this.locked(caseId, async tx => {
      const gap = await this.gap(tx, caseId, gapId, actor);
      if (!['OPEN','REVIEWED','DISMISSED'].includes(gap.status)) throw new ValidationError('Gap cannot be reviewed in its current state');
      await this.assertCurrent(tx, caseId, gap);
      const status = decision === 'select' ? 'REVIEWED' : 'DISMISSED';
      if (gap.status === status && gap.reviewedById === actor.id && gap.reviewNote === note) return gap;
      const updated = await tx.intelligenceGap.update({ where: { id: gapId }, data: { status, reviewedById: actor.id, reviewedAt: new Date(), reviewNote: note }, include: gapInclude });
      await this.audit(tx, caseId, actor, AuditAction.INTELLIGENCE_REVIEW, gapId, { decision });
      return updated;
    });
  }

  private async transition(tx: Prisma.TransactionClient, requestId: string, caseId: string, actor: IntelligenceActor,
    fromStatus: IntelligenceRequestStatus | null, toStatus: IntelligenceRequestStatus, eventType: string) {
    await tx.intelligenceRequest.update({ where: { id: requestId }, data: { status: toStatus } });
    await tx.intelligenceTransition.create({ data: { requestId, actorId: actor.id, fromStatus, toStatus, eventType } });
    await this.audit(tx, caseId, actor, fromStatus === null ? AuditAction.INTELLIGENCE_REQUEST_CREATE : AuditAction.INTELLIGENCE_TRANSITION,
      requestId, { fromStatus, toStatus, eventType });
  }

  /** Transition rows retain stable event IDs; retries replay undelivered events on the existing bus. */
  private async publishPending(requestId: string) {
    await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM intelligence_requests WHERE id = ${requestId} FOR UPDATE`;
    const request = await tx.intelligenceRequest.findUniqueOrThrow({ where: { id: requestId } });
    const transitions = await tx.intelligenceTransition.findMany({ where: { requestId, publishedAt: null }, orderBy: { sequence: 'asc' } });
    for (const t of transitions) {
      try {
        await eventBus.publish({ id: t.id, type: t.eventType, timestamp: t.createdAt.getTime(),
          payload: { caseId: request.caseId, requestId, gapId: request.gapId, sourceId: request.sourceId, fromStatus: t.fromStatus, toStatus: t.toStatus } });
        await tx.intelligenceTransition.update({ where: { id: t.id }, data: { publishedAt: new Date() } });
      } catch { console.error('Phase 3 event delivery pending retry:', t.id); break; }
    }
    });
  }

  async createRequest(caseId: string, gapId: string, actor: IntelligenceActor) {
    await this.access(caseId, actor, Permission.INTELLIGENCE_WRITE);
    const request = await this.locked(caseId, async tx => {
      const gap = await this.gap(tx, caseId, gapId, actor);
      const existing = await tx.intelligenceRequest.findUnique({ where: { gapId } });
      if (existing) return existing;
      if (gap.status !== 'REVIEWED' || !gap.reviewedById || !gap.reviewedAt) throw new ValidationError('Select the gap through investigator review first');
      await this.assertCurrent(tx, caseId, gap);
      const scope: RequestScope = { caseType: gap.caseType, requiredData: gap.requiredData, targetType: gap.targetType,
        targetEntity: gap.targetEntity, sourceId: gap.sourceId, timeFrom: gap.timeFrom.toISOString(), timeTo: gap.timeTo.toISOString(),
        purpose: gap.purpose, explanation: gap.explanation, priority: gap.priority, priorityReason: gap.priorityReason,
        reviewedById: gap.reviewedById, reviewedAt: gap.reviewedAt.toISOString(), origins: gap.origins.map(o => o.snapshot) };
      const created = await tx.intelligenceRequest.create({ data: { caseId, gapId, sourceId: gap.sourceId, scope: json(scope), createdById: actor.id } });
      await tx.intelligenceGap.update({ where: { id: gapId }, data: { status: 'REQUESTED' } });
      await this.transition(tx, created.id, caseId, actor, null, 'DRAFT', Events.CREATED);
      return created;
    });
    await this.publishPending(request.id);
    return request;
  }

  private async request(tx: Prisma.TransactionClient, caseId: string, requestId: string, actor: IntelligenceActor) {
    const request = await tx.intelligenceRequest.findFirst({ where: { id: requestId, caseId }, include: requestInclude });
    if (!request) throw new NotFoundError('Intelligence request not found');
    await this.sourceAccess(request.sourceId, actor);
    return request;
  }

  async listRequests(caseId: string, actor: IntelligenceActor) {
    await this.access(caseId, actor, Permission.INTELLIGENCE_READ);
    const items = await prisma.intelligenceRequest.findMany({ where: { caseId }, include: requestInclude, orderBy: { createdAt: 'asc' } });
    await this.audit(prisma, caseId, actor, AuditAction.INTELLIGENCE_READ, caseId, { view: 'requests' });
    return items.filter(r => this.canUseSource(r.sourceId, actor));
  }

  async getRequest(caseId: string, requestId: string, actor: IntelligenceActor) {
    await this.access(caseId, actor, Permission.INTELLIGENCE_READ);
    const result = await this.request(prisma, caseId, requestId, actor);
    await this.audit(prisma, caseId, actor, AuditAction.INTELLIGENCE_READ, requestId);
    return result;
  }

  async submit(caseId: string, requestId: string, actor: IntelligenceActor) {
    await this.access(caseId, actor, Permission.INTELLIGENCE_WRITE);
    const result = await this.locked(caseId, async tx => {
      const r = await this.request(tx, caseId, requestId, actor);
      if (r.status === 'PENDING_AUTHORIZATION') return r;
      if (r.status !== 'DRAFT') throw new ValidationError('Only a draft can be submitted');
      await this.assertCurrent(tx, caseId, await this.gap(tx, caseId, r.gapId, actor));
      await this.transition(tx, requestId, caseId, actor, 'DRAFT', 'SUBMITTED', Events.SUBMITTED);
      await this.transition(tx, requestId, caseId, actor, 'SUBMITTED', 'PENDING_AUTHORIZATION', Events.PENDING);
      return this.request(tx, caseId, requestId, actor);
    });
    await this.publishPending(requestId);
    return result;
  }

  async authorize(caseId: string, requestId: string, actor: IntelligenceActor, approved: boolean, reason: string) {
    await this.access(caseId, actor, Permission.INTELLIGENCE_AUTHORIZE);
    const result = await this.locked(caseId, async tx => {
      const r = await this.request(tx, caseId, requestId, actor);
      const assignment = await tx.caseAssignment.findUniqueOrThrow({ where: { caseId_userId: { caseId, userId: actor.id } } });
      const scope = r.scope as unknown as RequestScope;
      if (assignment.role !== 'supervisor' || r.createdById === actor.id || scope.reviewedById === actor.id) {
        await this.denied(actor);
        throw new ForbiddenError('An independent assigned supervisor must authorize the request');
      }
      if (r.authorization) {
        if (r.authorization.approved === approved && r.authorization.authorizedById === actor.id && r.authorization.reason === reason) return r;
        throw new ValidationError('An authorization decision already exists');
      }
      if (r.status !== 'PENDING_AUTHORIZATION') throw new ValidationError('Request is not pending authorization');
      if (approved) await this.assertCurrent(tx, caseId, await this.gap(tx, caseId, r.gapId, actor));
      await tx.intelligenceAuthorization.create({ data: { requestId, authorizedById: actor.id, approved, reason } });
      await this.transition(tx, requestId, caseId, actor, r.status, approved ? 'AUTHORIZED' : 'REJECTED', approved ? Events.AUTHORIZED : Events.REJECTED);
      return this.request(tx, caseId, requestId, actor);
    });
    await this.publishPending(requestId);
    return result;
  }

  async dispatch(caseId: string, requestId: string, actor: IntelligenceActor) {
    await this.access(caseId, actor, Permission.INTELLIGENCE_WRITE);
    const result = await this.locked(caseId, async tx => {
      const r = await this.request(tx, caseId, requestId, actor);
      if (['RECEIVED','COMPLETED'].includes(r.status)) return r;
      if (!['AUTHORIZED','FAILED','DISPATCHED'].includes(r.status) || !r.authorization?.approved) throw new ValidationError('An authorized request is required for dispatch');
      await this.assertCurrent(tx, caseId, await this.gap(tx, caseId, r.gapId, actor));
      if (r.status !== 'DISPATCHED') await this.transition(tx, requestId, caseId, actor, r.status, 'DISPATCHED', Events.DISPATCHED);
      const scope = r.scope as unknown as RequestScope;
      let exchange: Awaited<ReturnType<typeof exchangeSynthetic>>;
      try { exchange = await exchangeSynthetic({ id: requestId, caseId, sourceId: r.sourceId, scope }); }
      catch {
        await tx.intelligenceRequest.update({ where: { id: requestId }, data: { failureReason: 'Synthetic source exchange failed; retry is allowed.' } });
        await this.transition(tx, requestId, caseId, actor, 'DISPATCHED', 'FAILED', Events.FAILED);
        return this.request(tx, caseId, requestId, actor);
      }
      const origins = scope.origins as { evidenceRecordId?: string }[];
      const evidence = await evidenceStoreService.receiveExternalPackage(tx, { caseId, requestId, sourceId: r.sourceId,
        authorizationId: r.authorization.id, actorId: actor.id, payload: exchange.payload,
        parentEvidenceId: origins.find(o => o.evidenceRecordId)?.evidenceRecordId, origins });
      await tx.intelligenceResponse.create({ data: { requestId, evidenceRecordId: evidence.id, receiptKey: exchange.receipt.key } });
      await tx.intelligenceRequest.update({ where: { id: requestId }, data: { failureReason: null } });
      await this.transition(tx, requestId, caseId, actor, 'DISPATCHED', 'RECEIVED', Events.RECEIVED);
      return this.request(tx, caseId, requestId, actor);
    });
    await this.publishPending(requestId);
    return result;
  }

  async complete(caseId: string, requestId: string, actor: IntelligenceActor) {
    await this.access(caseId, actor, Permission.INTELLIGENCE_WRITE);
    const result = await this.locked(caseId, async tx => {
      const r = await this.request(tx, caseId, requestId, actor);
      if (r.status === 'COMPLETED') return r;
      if (r.status !== 'RECEIVED' || !r.response) throw new ValidationError('A received package is required before completion');
      await this.transition(tx, requestId, caseId, actor, 'RECEIVED', 'COMPLETED', Events.COMPLETED);
      await tx.intelligenceGap.update({ where: { id: r.gapId }, data: { status: 'RESOLVED' } });
      return this.request(tx, caseId, requestId, actor);
    });
    await this.publishPending(requestId);
    return result;
  }

  async response(caseId: string, requestId: string, actor: IntelligenceActor) {
    const r = await this.getRequest(caseId, requestId, actor);
    if (!r.response) throw new NotFoundError('Returned intelligence not found');
    const evidence = await prisma.evidenceRecord.findFirstOrThrow({ where: { id: r.response.evidenceRecordId, caseId }, include: { document: true } });
    return { ...r.response, source: r.source, caseId, payload: await evidenceStoreService.readExternalPackage(evidence) };
  }
}

export const intelligenceService = new IntelligenceService();
