import { Router, type Request } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.middleware';
import type { CaseActor } from '../auth/policies';
import { brainService as brain } from './brain.service';
import { BRAIN_RULES as R } from './rules';
import { RELATIONSHIP_TYPES } from './types';

export const brainRouter=Router();
const base='/cases/:caseId/brain';
const actor=(req:Request):CaseActor=>({...req.user!,ipAddress:req.ip});
const id=(req:Request,key='caseId')=>z.string().uuid().parse(req.params[key]);
const page=z.object({offset:z.coerce.number().int().min(0).max(100000).default(0),limit:z.coerce.number().int().min(1).max(R.maxResults).default(50)});
const depth=z.coerce.number().int().min(1).max(R.maxHops);
brainRouter.use(base,authenticate);
for(const [route,type] of [['run','full'],['graph/sync','sync'],['graph/rebuild','rebuild'],['network/run','network'],['patterns/run','patterns']] as const) {
  brainRouter.post(`${base}/${route}`,async(req,res)=>{z.object({}).strict().parse(req.body??{});const result=await brain.run(id(req),actor(req),type);res.status(result.status==='FAILED'?503:200).json(result);});
}
brainRouter.get(`${base}/graph/status`,async(req,res)=>res.json(await brain.status(id(req),actor(req))));
brainRouter.get(`${base}/graph`,async(req,res)=>{const p=page.strict().parse(req.query);res.json(await brain.graphView(id(req),actor(req),p.offset,p.limit));});
brainRouter.get(`${base}/graph/neighborhood/:entityId`,async(req,res)=>{const p=z.object({hops:depth.default(1),limit:page.shape.limit}).strict().parse(req.query);res.json(await brain.neighbors(id(req),actor(req),id(req,'entityId'),p.hops,p.limit));});
brainRouter.get(`${base}/graph/paths`,async(req,res)=>{const p=z.object({source:z.string().uuid(),target:z.string().uuid(),hops:depth.default(R.maxHops),limit:page.shape.limit,mode:z.enum(['shortest','multi']).default('shortest')}).strict().parse(req.query);res.json(await brain.path(id(req),actor(req),p.source,p.target,p.hops,p.limit,p.mode==='shortest'));});
brainRouter.get(`${base}/network`,async(req,res)=>res.json(await brain.network(id(req),actor(req))));
brainRouter.get(`${base}/network/centrality`,async(req,res)=>res.json({items:(await brain.network(id(req),actor(req))).metrics}));
brainRouter.get(`${base}/network/communities`,async(req,res)=>res.json({items:(await brain.network(id(req),actor(req))).communities}));
brainRouter.get(`${base}/network/key-entities`,async(req,res)=>{const {limit}=page.pick({limit:true}).strict().parse(req.query);const network=await brain.network(id(req),actor(req));res.json({
  highlyConnected:[...network.metrics].sort((a,b)=>b.degree-a.degree).slice(0,limit),
  bridgeEntities:[...network.metrics].sort((a,b)=>b.betweenness-a.betweenness).slice(0,limit),
  structurallyInfluential:[...network.metrics].sort((a,b)=>b.pageRank-a.pageRank).slice(0,limit),algorithm:network.algorithm});});
brainRouter.get(`${base}/timeline`,async(req,res)=>{const p=page.extend({entityId:z.string().uuid().optional(),type:z.enum(RELATIONSHIP_TYPES).optional(),from:z.string().datetime({offset:true}).optional(),to:z.string().datetime({offset:true}).optional()}).strict().parse(req.query);res.json(await brain.timeline(id(req),actor(req),p));});
brainRouter.get(`${base}/signals`,async(req,res)=>{const p=page.extend({type:z.string().max(100).optional()}).strict().parse(req.query);res.json(await brain.signals(id(req),actor(req),p.offset,p.limit,p.type));});
brainRouter.get(`${base}/signals/:signalId`,async(req,res)=>res.json(await brain.signal(id(req),actor(req),id(req,'signalId'))));
brainRouter.get(`${base}/runs`,async(req,res)=>{const p=page.strict().parse(req.query);res.json(await brain.runs(id(req),actor(req),p.offset,p.limit));});
