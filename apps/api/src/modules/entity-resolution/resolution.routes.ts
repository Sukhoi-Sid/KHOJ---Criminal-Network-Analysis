import { Router, type Request } from 'express';
import { ResolutionStatus } from '@prisma/client';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.middleware';
import type { CaseActor } from '../auth/policies';
import { entityResolutionService as service } from './resolution.service';

export const resolutionRouter = Router();
const base = '/cases/:caseId/resolution';
const actor = (req: Request): CaseActor => ({ ...req.user!,ipAddress: req.ip });
const id = (req: Request,key: string) => z.string().uuid().parse(req.params[key]);
const filter = z.object({ status: z.nativeEnum(ResolutionStatus).optional() }).strict();
const review = z.object({ decision: z.enum(['accept','reject']),reason: z.string().trim().min(1).max(2000),
  expectedRevision: z.number().int().positive(),idempotencyKey: z.string().uuid() }).strict();
resolutionRouter.use(base,authenticate);
resolutionRouter.post(`${base}/integrate`,async (req,res) => {
  z.object({}).strict().parse(req.body ?? {});
  res.json(await service.integrate(id(req,'caseId'),actor(req)));
});
resolutionRouter.get(`${base}/entities`,async (req,res) => {
  const { status } = filter.parse(req.query);
  res.json(await service.entities(id(req,'caseId'),actor(req),status));
});
resolutionRouter.get(`${base}/entities/:entityId`,async (req,res) => res.json(await service.entity(id(req,'caseId'),id(req,'entityId'),actor(req))));
resolutionRouter.get(`${base}/records`,async (req,res) => res.json(await service.records(id(req,'caseId'),actor(req))));
resolutionRouter.get(`${base}/candidates`,async (req,res) => {
  const { status } = filter.parse(req.query);
  res.json(await service.candidates(id(req,'caseId'),actor(req),status));
});
resolutionRouter.get(`${base}/candidates/:candidateId`,async (req,res) => res.json(await service.candidate(id(req,'caseId'),id(req,'candidateId'),actor(req))));
resolutionRouter.post(`${base}/candidates/:candidateId/review`,async (req,res) => {
  res.json(await service.review(id(req,'caseId'),id(req,'candidateId'),actor(req),review.parse(req.body)));
});
resolutionRouter.get(`${base}/history`,async (req,res) => res.json(await service.historyForCase(id(req,'caseId'),actor(req))));
