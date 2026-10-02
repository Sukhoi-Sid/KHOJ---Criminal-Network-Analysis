import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../../core/db';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../../core/errors';
import { AuditAction, AuditResourceType, Permission, ROLE_PERMISSIONS, UserRole } from '@sih/shared';
import type { AuthenticatedUser } from '../../middleware/auth.middleware';
import { auditService } from '../audit/audit.service';
import { intelligenceRegistry } from '../intelligence-requirements/registry';

export interface CaseActor extends AuthenticatedUser { ipAddress?: string }

export async function auditAccessDenied(actor: CaseActor) {
  const exists = await prisma.user.findUnique({ where: { id: actor.id }, select: { id: true } });
  await auditService.emit({ actorId: exists?.id, actorEmail: actor.email, action: AuditAction.ACCESS_DENIED,
    resourceType: AuditResourceType.CASE, ipAddress: actor.ipAddress });
}

/** Shared Phase 3/4 role + case gate. Phase 1/2 HTTP contracts remain unchanged. */
export async function assertCasePermission(caseId: string, actor: CaseActor, permission: Permission) {
  const user = await prisma.user.findUnique({ where: { id: actor.id } });
  if (!user || user.role !== actor.role || !ROLE_PERMISSIONS[user.role as UserRole]?.includes(permission)) {
    await auditAccessDenied(actor);
    throw new ForbiddenError('Case permission required');
  }
  try { await assertCaseAccess(actor.id, caseId); }
  catch (error) {
    if (!(error instanceof NotFoundError || error instanceof ForbiddenError)) throw error;
    await auditAccessDenied(actor);
    throw new NotFoundError('Case not found');
  }
}

export function canUseSource(sourceId: string, actor: CaseActor) {
  return intelligenceRegistry.sources.some(s => s.id === sourceId && ROLE_PERMISSIONS[actor.role].includes(s.permission));
}
export async function assertSourceAccess(sourceId: string, actor: CaseActor) {
  if (!canUseSource(sourceId, actor)) {
    await auditAccessDenied(actor);
    throw new ForbiddenError('Source permission required');
  }
}

/** A combined derived view can expose restricted sources through another member. */
export async function assertDerivedCasePermission(caseId:string,actor:CaseActor,permission:Permission) {
  await assertCasePermission(caseId,actor,permission);
  const sources=await prisma.intelligenceRequest.findMany({where:{caseId,response:{isNot:null}},select:{sourceId:true},distinct:['sourceId']});
  for(const source of sources)await assertSourceAccess(source.sourceId,actor);
}

/**
 * ABAC rule (Blueprint §10): a user may access a case only if they hold a
 * `CaseAssignment` row for it — regardless of platform role. `admin` has no
 * default case-content access (user management only). `auditor` gets
 * audit/provenance read access elsewhere, not case content. `supervisor`
 * access is likewise assignment-scoped (their "team's cases" are the cases
 * they are assigned to as CaseAssignmentRole.SUPERVISOR/INVESTIGATOR) — a
 * supervisor is NOT granted blanket access to every case in the system.
 *
 * SECURITY FIX: a previous version of this function granted every
 * `supervisor`-role user unconditional access to *any* case by id. That was
 * an overly broad permission grant (case content is meant to be case-scoped
 * for every non-auditor/admin role) and has been removed. This is the
 * single, non-duplicated ABAC primitive for case access — both the route
 * middleware (`requireCaseAccess`) and any service that receives a resource
 * id without a `caseId` route param (e.g. evidence-store fetching a
 * document/evidence record by id) must call `assertCaseAccess` rather than
 * re-implementing this check.
 *
 * Status codes preserve existing, already-tested behavior: 404 when the
 * case id doesn't exist at all, 403 when it exists but the user has no
 * assignment on it. Either way, access is denied — the IDOR fix is that
 * *no* role bypasses the assignment check, not the specific status code.
 */
export async function assertCaseAccess(userId: string, caseId: string): Promise<void> {
  const kase = await prisma.case.findUnique({ where: { id: caseId }, select: { id: true } });
  if (!kase) {
    throw new NotFoundError('Case not found');
  }

  const assignment = await prisma.caseAssignment.findUnique({
    where: { caseId_userId: { caseId, userId } },
    select: { id: true },
  });

  if (!assignment) {
    throw new ForbiddenError('Not assigned to this case');
  }
}

/** Express middleware form of `assertCaseAccess`. Reads `caseId` from
 * `req.params.caseId` (falling back to `req.params.id`); expects
 * `authenticate` to have run first. */
export async function requireCaseAccess(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }

  const caseId = String(req.params.caseId) ?? req.params.id;
  if (!caseId) {
    throw new NotFoundError('Case id missing from request');
  }

  await assertCaseAccess(req.user.id, caseId);
  next();
}
