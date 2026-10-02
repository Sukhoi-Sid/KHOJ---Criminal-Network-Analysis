import { Prisma, type NormalizedSourceRecord, type ResolutionCandidate } from '@prisma/client';
import { AuditAction, AuditResourceType, Permission, type EntityType, type EntityIdentifiers, type ResolutionReviewRequest } from '@sih/shared';
import { prisma } from '../../core/db';
import { eventBus } from '../../core/domain-events';
import { NotFoundError, ValidationError } from '../../core/errors';
import { assertDerivedCasePermission, type CaseActor } from '../auth/policies';
import { auditService } from '../audit/audit.service';
import { collectSourceRecords, stableDigest, toJson } from './integration';
import { candidatePairs, entityResolvers, RESOLUTION_RULES, type MatchRecord } from './resolvers';
import { clusterRecords, conflictingGroups } from './clustering';
import { ResolutionEvents as Events } from './events';

const matchRecord = (r: NormalizedSourceRecord): MatchRecord => ({ id: r.id, entityType: r.entityType as EntityType,
  normalizedValue: r.normalizedValue, validIdentifier: r.validIdentifier, identifiers: r.identifiers as EntityIdentifiers });
const recordInclude = { evidenceRecord: { include: { provenance: true } } } as const;

export class EntityResolutionService {
  private async access(caseId: string, actor: CaseActor, permission: Permission) {
    await assertDerivedCasePermission(caseId,actor,permission);
  }
  private async locked<T>(caseId: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async tx => { await tx.$queryRaw`SELECT id FROM cases WHERE id = ${caseId} FOR UPDATE`; return work(tx); }, { timeout: 60_000, maxWait: 20_000 });
  }
  private async audit(tx: Prisma.TransactionClient, caseId: string, actor: CaseActor, action: AuditAction, resourceId: string, metadata: Record<string,unknown> = {}) {
    await auditService.emit({ caseId, actorId: actor.id, actorEmail: actor.email, action,
      resourceType: action === AuditAction.ENTITY_REVIEW ? AuditResourceType.RESOLUTION_CANDIDATE : AuditResourceType.CANONICAL_ENTITY,
      resourceId, metadata, ipAddress: actor.ipAddress },tx);
  }
  private async history(tx: Prisma.TransactionClient, caseId: string, actor: CaseActor, eventType: string,
    payload: unknown, options: { candidateId?: string; fromStatus?: ResolutionCandidate['status']; toStatus?: ResolutionCandidate['status']; reason?: string; idempotencyKey?: string } = {}) {
    return tx.resolutionHistory.create({ data: { caseId, actorId: actor.id, eventType, payload: toJson(payload),
      ...options, reason: options.reason ?? 'Deterministic entity resolution; source evidence remains authoritative.' } });
  }

  private async publish(caseId: string) {
    // Same durable-history + existing-event-bus convention as Phase 3.
    await this.locked(caseId, async tx => {
      const entries = await tx.resolutionHistory.findMany({ where: { caseId, publishedAt: null }, orderBy: { sequence: 'asc' } });
      for (const entry of entries) {
        try {
          await eventBus.publish({ id: entry.id, type: entry.eventType, timestamp: entry.createdAt.getTime(),
            payload: { ...(entry.payload as Record<string,unknown>), caseId, sequence: entry.sequence, candidateId: entry.candidateId } });
          await tx.resolutionHistory.update({ where: { id: entry.id }, data: { publishedAt: new Date() } });
        } catch { console.error('Entity resolution event pending retry:',entry.id); break; }
      }
    });
  }

  private async rebuild(tx: Prisma.TransactionClient, caseId: string, actor: CaseActor) {
    const records = await tx.normalizedSourceRecord.findMany({ where: { caseId, active: true }, orderBy: { id: 'asc' } });
    let candidates = await tx.resolutionCandidate.findMany({ where: { caseId, active: true }, orderBy: { id: 'asc' } });
    const matches = records.map(matchRecord);
    let clustering = clusterRecords(matches,candidates);
    for (const blocked of clustering.blocked) {
      const candidate = candidates.find(c => c.id === blocked.candidateId)!;
      await tx.resolutionCandidate.update({ where: { id: candidate.id }, data: { status: 'REVIEW_REQUIRED', revision: { increment: 1 },
        conflicts: toJson([...(candidate.conflicts as unknown[]), { field: 'cluster', strength: 'conflict', detail: blocked.reasons.join('; ') }]) } });
      await this.history(tx,caseId,actor,Events.REVIEW,{ reasons: blocked.reasons },{
        candidateId: candidate.id, fromStatus: candidate.status, toStatus: 'REVIEW_REQUIRED', reason: 'Transitive merge blocked by a conflicting record or distinct decision.' });
    }
    if (clustering.blocked.length) {
      candidates = await tx.resolutionCandidate.findMany({ where: { caseId, active: true }, orderBy: { id: 'asc' } });
      clustering = clusterRecords(matches,candidates);
    }
    const activeKeys: string[] = [];
    for (const group of clustering.groups) {
      const ids = group.map(r => r.id).sort();
      const membershipKey = stableDigest(ids); activeKeys.push(membershipKey);
      const sourceRows = ids.map(id => records.find(r => r.id === id)!);
      const relevant = candidates.filter(c => ids.includes(c.leftId) || ids.includes(c.rightId));
      const internal = relevant.filter(c => ids.includes(c.leftId) && ids.includes(c.rightId) && ['ACCEPTED','AUTO_RESOLVED'].includes(c.status));
      const status = group.length > 1 ? internal.some(c => c.status === 'ACCEPTED') ? 'ACCEPTED' : 'AUTO_RESOLVED'
        : relevant.some(c => c.status === 'REVIEW_REQUIRED') ? 'REVIEW_REQUIRED' : 'UNRESOLVED';
      const confidence = internal.length ? Math.min(...internal.map(c => c.score)) : 0;
      // Prefer higher-quality source label; never replace the original spellings/attributes on records.
      const preferred = [...sourceRows].sort((a,b) => a.reliabilityTier.localeCompare(b.reliabilityTier) || b.rawValue.length-a.rawValue.length || a.id.localeCompare(b.id))[0];
      const prior = await tx.canonicalEntity.findUnique({ where: { caseId_membershipKey: { caseId,membershipKey } } });
      const data = { entityType: preferred.entityType, displayLabel: preferred.rawValue, resolutionStatus: status as ResolutionCandidate['status'], confidence, active: true };
      let entity = prior;
      if (!prior) {
        entity = await tx.canonicalEntity.create({ data: { caseId,membershipKey,...data } });
        await tx.entitySourceLink.createMany({ data: ids.map(recordId => ({ caseId,recordId,entityId: entity!.id })) });
      }
      else if (!prior.active || prior.resolutionStatus !== status || prior.confidence !== confidence || prior.displayLabel !== data.displayLabel) {
        entity = await tx.canonicalEntity.update({ where: { id: prior.id }, data });
      }
      if (!entity) throw new Error('Missing entity');
    }
    await tx.canonicalEntity.updateMany({ where: { caseId, active: true, membershipKey: { notIn: activeKeys } }, data: { active: false } });
    const digest = stableDigest({ records: records.map(r => r.sourceKey).sort(), candidates: candidates.map(c => [c.id,c.status,c.revision]), membership: activeKeys.sort(), version: RESOLUTION_RULES.version });
    const summary = { digest, integrationCompleted: true, canonicalEntities: activeKeys.length, normalizedRecords: records.length,
      reviewRequired: candidates.filter(c => c.status === 'REVIEW_REQUIRED').length,
      unresolvedEntities: await tx.canonicalEntity.count({ where: { caseId,active: true,resolutionStatus: 'UNRESOLVED' } }),
      ruleVersion: RESOLUTION_RULES.version };
    const previous = await tx.resolutionHistory.findFirst({ where: { caseId,eventType: Events.COMPLETED }, orderBy: { sequence: 'desc' } });
    const reused = (previous?.payload as Record<string,unknown> | undefined)?.digest === digest;
    if (!reused) await this.history(tx,caseId,actor,Events.COMPLETED,summary);
    return { ...summary, reused };
  }

  async integrate(caseId: string, actor: CaseActor) {
    await this.access(caseId,actor,Permission.ENTITY_RESOLVE);
    const result = await this.locked(caseId, async tx => {
      const inputs = await collectSourceRecords(tx,caseId);
      const before = await tx.normalizedSourceRecord.findMany({ where: { caseId } });
      const keys = new Set(inputs.map(i => i.sourceKey));
      const retired = before.filter(r => r.active && !keys.has(r.sourceKey));
      const changed = inputs.some(i => !before.some(r => r.sourceKey === i.sourceKey && r.active)) || retired.length > 0;
      if (changed) await this.history(tx,caseId,actor,Events.STARTED,{ inputRecords: inputs.length });
      await tx.normalizedSourceRecord.updateMany({ where: { caseId,active: true,sourceKey: { notIn: [...keys] } }, data: { active: false } });
      for (const input of inputs) {
        const prior = before.find(r => r.sourceKey === input.sourceKey);
        if (!prior) await tx.normalizedSourceRecord.create({ data: input });
        else if (!prior.active || (input.mentionId && prior.mentionId !== input.mentionId)) {
          await tx.normalizedSourceRecord.update({ where: { id: prior.id }, data: { active: true, mentionId: input.mentionId } });
        }
      }
      if (changed) await this.history(tx,caseId,actor,Events.NORMALIZED,{ records: inputs.length, retired: retired.length });
      const rows = await tx.normalizedSourceRecord.findMany({ where: { caseId,active: true } });
      const pairs = candidatePairs(rows.map(matchRecord));
      const newAutomatic: string[] = [];
      await tx.resolutionCandidate.updateMany({ where: { caseId,active: true, OR: [{ left: { active: false } },{ right: { active: false } }] }, data: { active: false } });
      for (const [left,right] of pairs) {
        const existing = await tx.resolutionCandidate.findUnique({ where: { caseId_leftId_rightId: { caseId,leftId: left.id,rightId: right.id } } });
        if (existing) {
          if (!existing.active) await tx.resolutionCandidate.update({ where: { id: existing.id }, data: { active: true } });
          continue;
        }
        const match = entityResolvers[left.entityType].compare(left,right);
        if (match.status === 'UNRESOLVED') continue;
        const candidate = await tx.resolutionCandidate.create({ data: { caseId,leftId: left.id,rightId: right.id,
          score: match.score,status: match.status,signals: toJson(match.signals),conflicts: toJson(match.conflicts),ruleVersion: RESOLUTION_RULES.version } });
        await this.history(tx,caseId,actor,Events.CANDIDATE,match,{ candidateId: candidate.id,toStatus: candidate.status });
        if (candidate.status === 'AUTO_RESOLVED') newAutomatic.push(candidate.id);
        if (candidate.status === 'REVIEW_REQUIRED') await this.history(tx,caseId,actor,
          Events.REVIEW,match,{ candidateId: candidate.id,toStatus: candidate.status });
      }
      const summary = await this.rebuild(tx,caseId,actor);
      // Only announce automatic equivalence after transitive conflict checks succeeded.
      for (const candidate of await tx.resolutionCandidate.findMany({ where: { id: { in: newAutomatic },status: 'AUTO_RESOLVED' } })) {
        await this.history(tx,caseId,actor,Events.AUTO,{ score: candidate.score,signals: candidate.signals },{ candidateId: candidate.id,toStatus: candidate.status });
      }
      await this.audit(tx,caseId,actor,AuditAction.ENTITY_INTEGRATE,caseId,{ ...summary, comparisons: pairs.length });
      return { ...summary, comparisons: pairs.length };
    });
    await this.publish(caseId);
    return result;
  }

  async review(caseId: string, candidateId: string, actor: CaseActor, input: ResolutionReviewRequest) {
    await this.access(caseId,actor,Permission.ENTITY_RESOLVE);
    const result = await this.locked(caseId, async tx => {
      const candidate = await tx.resolutionCandidate.findFirst({ where: { id: candidateId,caseId } });
      if (!candidate) throw new NotFoundError('Resolution candidate not found');
      const next = input.decision === 'accept' ? 'ACCEPTED' : 'REJECTED';
      const priorDecision = await tx.resolutionHistory.findUnique({ where: { caseId_idempotencyKey: { caseId,idempotencyKey: input.idempotencyKey } } });
      if (priorDecision) {
        if (priorDecision.candidateId !== candidateId || priorDecision.actorId !== actor.id || priorDecision.reason !== input.reason || priorDecision.toStatus !== next ||
          (priorDecision.payload as Record<string,unknown>).expectedRevision !== input.expectedRevision) throw new ValidationError('Idempotency key was already used for another decision');
        return { candidate, decision: priorDecision, reused: true };
      }
      if (!candidate.active || candidate.revision !== input.expectedRevision) throw new ValidationError('Candidate changed; reload its current revision before review');
      if (candidate.status === next) throw new ValidationError('Candidate already has this decision; reuse the original idempotency key to retry');
      // Check current input keys so a removed/reprocessed source cannot be accepted before reintegration.
      const inputs = await collectSourceRecords(tx,caseId);
      const stored = await tx.normalizedSourceRecord.findMany({ where: { caseId,active: true } });
      const inputKeys = inputs.map(i => i.sourceKey).sort();
      if (JSON.stringify(inputKeys) !== JSON.stringify(stored.map(r => r.sourceKey).sort())) throw new ValidationError('Source context changed; integrate the case before reviewing');
      if (input.decision === 'accept') {
        const matches = stored.map(matchRecord);
        const allCandidates = await tx.resolutionCandidate.findMany({ where: { caseId,active: true } });
        const withoutTarget = allCandidates.filter(c => c.id !== candidateId);
        const clusters = clusterRecords(matches,withoutTarget).groups;
        const left = clusters.find(g => g.some(r => r.id === candidate.leftId))!;
        const right = clusters.find(g => g.some(r => r.id === candidate.rightId))!;
        const conflicts = conflictingGroups(left,right,withoutTarget);
        if (conflicts.length) throw new ValidationError('Conflicting source identifiers or an existing distinct decision prevent this merge', { conflicts });
      }
      const updated = await tx.resolutionCandidate.update({ where: { id: candidateId }, data: { status: next, revision: { increment: 1 } } });
      const decision = await this.history(tx,caseId,actor,input.decision === 'accept' ? Events.ACCEPTED : Events.REJECTED,
        { expectedRevision: input.expectedRevision, score: candidate.score, signals: candidate.signals, conflicts: candidate.conflicts },{
          candidateId, fromStatus: candidate.status,toStatus: next,reason: input.reason,idempotencyKey: input.idempotencyKey });
      await this.rebuild(tx,caseId,actor);
      await this.audit(tx,caseId,actor,AuditAction.ENTITY_REVIEW,candidateId,{ decision: input.decision,revision: updated.revision,historyId: decision.id });
      return { candidate: updated, decision, reused: false };
    });
    await this.publish(caseId);
    return result;
  }

  async entities(caseId: string, actor: CaseActor, status?: ResolutionCandidate['status']) {
    await this.access(caseId,actor,Permission.ENTITY_READ);
    const items = await prisma.canonicalEntity.findMany({ where: { caseId,active: true,...(status ? { resolutionStatus: status } : {}) }, orderBy: [{ entityType: 'asc' },{ id: 'asc' }] });
    await this.audit(prisma,caseId,actor,AuditAction.ENTITY_READ,caseId,{ view: 'entities' });
    return { items,total: items.length };
  }
  async entity(caseId: string, entityId: string, actor: CaseActor) {
    await this.access(caseId,actor,Permission.ENTITY_READ);
    const entity = await prisma.canonicalEntity.findFirst({ where: { id: entityId,caseId }, include: { sources: { include: { record: { include: recordInclude } } } } });
    if (!entity) throw new NotFoundError('Canonical entity not found');
    const ids = entity.sources.map(s => s.recordId);
    const candidates = await prisma.resolutionCandidate.findMany({ where: { caseId,OR: [{ leftId: { in: ids } },{ rightId: { in: ids } }] }, include: { history: { orderBy: { sequence: 'asc' } } } });
    await this.audit(prisma,caseId,actor,AuditAction.ENTITY_READ,entityId);
    return { ...entity,candidates,derived: true };
  }
  async candidates(caseId: string, actor: CaseActor, status?: ResolutionCandidate['status']) {
    await this.access(caseId,actor,Permission.ENTITY_READ);
    const items = await prisma.resolutionCandidate.findMany({ where: { caseId,active: true,...(status ? { status } : {}) },
      include: { left: true,right: true }, orderBy: { id: 'asc' } });
    await this.audit(prisma,caseId,actor,AuditAction.ENTITY_READ,caseId,{ view: 'candidates' });
    return { items,total: items.length };
  }
  async candidate(caseId: string, candidateId: string, actor: CaseActor) {
    await this.access(caseId,actor,Permission.ENTITY_READ);
    const result = await prisma.resolutionCandidate.findFirst({ where: { id: candidateId,caseId },
      include: { left: { include: recordInclude },right: { include: recordInclude },history: { orderBy: { sequence: 'asc' } } } });
    if (!result) throw new NotFoundError('Resolution candidate not found');
    await this.audit(prisma,caseId,actor,AuditAction.ENTITY_READ,candidateId);
    return result;
  }
  async records(caseId: string, actor: CaseActor) {
    await this.access(caseId,actor,Permission.ENTITY_READ);
    const items = await prisma.normalizedSourceRecord.findMany({ where: { caseId,active: true }, include: recordInclude,orderBy: { id: 'asc' } });
    await this.audit(prisma,caseId,actor,AuditAction.ENTITY_READ,caseId,{ view: 'normalized-records' });
    return { items,total: items.length };
  }
  async historyForCase(caseId: string, actor: CaseActor) {
    await this.access(caseId,actor,Permission.ENTITY_READ);
    const items = await prisma.resolutionHistory.findMany({ where: { caseId },orderBy: { sequence: 'asc' } });
    await this.audit(prisma,caseId,actor,AuditAction.ENTITY_READ,caseId,{ view: 'history' });
    return { items,total: items.length };
  }
}
export const entityResolutionService = new EntityResolutionService();
