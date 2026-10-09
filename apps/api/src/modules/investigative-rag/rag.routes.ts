import {Router,type Request} from 'express';
import {z} from 'zod';
import {authenticate} from '../../middleware/auth.middleware';
import type {CaseActor} from '../auth/policies';
import {investigativeRagService} from './rag.service';

export const ragRouter=Router();const base='/cases/:caseId/investigate';
const actor=(req:Request):CaseActor=>({...req.user!,ipAddress:req.ip});
const uuid=z.string().uuid();
const ask=z.object({question:z.string().trim().min(3).max(1000),entityIds:z.array(uuid).max(4).optional(),from:z.string().datetime({offset:true}).optional(),to:z.string().datetime({offset:true}).optional(),conversation:z.object({lastEntityId:uuid.optional()}).strict().optional()}).strict().refine(v=>!v.from||!v.to||Date.parse(v.from)<=Date.parse(v.to),{message:'Invalid chronological window'});
ragRouter.use(base,authenticate);
ragRouter.post(`${base}/ask`,async(req,res)=>res.json(await investigativeRagService.ask(uuid.parse(req.params.caseId),actor(req),ask.parse(req.body))));
ragRouter.get(`${base}/explanations/:kind/:id`,async(req,res)=>res.json(await investigativeRagService.explain(uuid.parse(req.params.caseId),actor(req),z.enum(['relationship','signal','entity','evidence']).parse(req.params.kind),uuid.parse(req.params.id))));
