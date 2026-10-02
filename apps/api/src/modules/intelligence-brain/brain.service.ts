import type { Prisma, DerivedRelationship } from '@prisma/client';
import { AuditAction, AuditResourceType, Permission, type EntityType } from '@sih/shared';
import { prisma } from '../../core/db';
import { hashJson, toJson } from '../../core/json';
import { eventBus } from '../../core/domain-events';
import { NotFoundError, ValidationError } from '../../core/errors';
import { assertDerivedCasePermission, type CaseActor } from '../auth/policies';
import { auditService } from '../audit/audit.service';
import { extractRelationships } from './graph-builder/relationships';
import { graphStore, checkConsistency, topologyDigest } from './graph-builder/graph-store';
import { analyzeNetwork, paths, neighborhood } from './analytics/network';
import { analyzePatterns } from './analytics/patterns';
import { timeline, activity, type TimelineFilter } from './analytics/temporal';
import { BRAIN_RULES as R } from './rules';
import { BrainEvents as E } from './events';
import type { CaseGraph, GraphEdge } from './types';

type RunType='sync'|'rebuild'|'network'|'patterns'|'full';
const edge=(r:DerivedRelationship):GraphEdge=>({...r,type:r.type as GraphEdge['type'],direction:'DIRECTED',findingKind:r.findingKind as GraphEdge['findingKind'],
  occurredAt:r.occurredAt?.toISOString()??null,observedAt:r.observedAt?.toISOString()??null,endAt:r.endAt?.toISOString()??null,
  evidenceRefs:r.evidenceRefs as unknown as GraphEdge['evidenceRefs'],sourceRecordIds:r.sourceRecordIds as string[],attributes:r.attributes as Record<string,unknown>});

export class BrainService {
  private access(caseId:string,actor:CaseActor,write=false) {return assertDerivedCasePermission(caseId,actor,write?Permission.BRAIN_EXECUTE:Permission.BRAIN_READ);}
  private locked<T>(caseId:string,work:(tx:Prisma.TransactionClient)=>Promise<T>) {
    return prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM cases WHERE id=${caseId} FOR UPDATE`;return work(tx);},{timeout:90000,maxWait:30000});
  }
  private audit(tx:Prisma.TransactionClient,caseId:string,actor:CaseActor,action:AuditAction,metadata:unknown={}) {
    return auditService.emit({caseId,actorId:actor.id,actorEmail:actor.email,action,resourceType:AuditResourceType.CASE_GRAPH,resourceId:caseId,ipAddress:actor.ipAddress,metadata:metadata as Record<string,unknown>},tx);
  }
  private event(tx:Prisma.TransactionClient,caseId:string,type:string,payload:unknown) {return tx.brainEvent.create({data:{caseId,type,payload:toJson(payload)}});}
  private async publish(caseId:string) {
    await this.locked(caseId,async tx=>{
      for(const e of await tx.brainEvent.findMany({where:{caseId,publishedAt:null},orderBy:{sequence:'asc'}})) {
        try {await eventBus.publish({id:e.id,type:e.type,timestamp:e.createdAt.getTime(),payload:{...e.payload as Record<string,unknown>,caseId,sequence:e.sequence}});
          await tx.brainEvent.update({where:{id:e.id},data:{publishedAt:new Date()}});
        }catch{console.error('Brain event delivery pending retry:',e.id);break;}
      }
    });
  }
  private async graph(tx:Prisma.TransactionClient,caseId:string):Promise<CaseGraph> {
    const nodes=await tx.canonicalEntity.findMany({where:{caseId,active:true},orderBy:{id:'asc'}});
    const relationships=await tx.derivedRelationship.findMany({where:{caseId,active:true,source:{active:true},target:{active:true}},orderBy:{id:'asc'}});
    if(nodes.length>R.maxNodes||relationships.length>R.maxEdges)throw new ValidationError('Case exceeds analytical limits');
    return {nodes:nodes.map(n=>({id:n.id,caseId,entityType:n.entityType as EntityType,label:n.displayLabel})),edges:relationships.map(edge)};
  }
  private async current(tx:Prisma.TransactionClient,caseId:string) {
    const inputs=await extractRelationships(tx,caseId);
    const stored=await tx.derivedRelationship.findMany({where:{caseId,active:true}});
    if(JSON.stringify(inputs.map(r=>r.stableKey).sort())!==JSON.stringify(stored.map(r=>r.stableKey).sort()))throw new ValidationError('Relationship state is stale; sync the case graph');
    return this.graph(tx,caseId);
  }
  async run(caseId:string,actor:CaseActor,type:RunType='full') {
    await this.access(caseId,actor,true);
    const run=await prisma.analysisRun.create({data:{caseId,actorId:actor.id,type,inputDigest:'pending',algorithmVersion:R.version,parameters:toJson(R),status:'RUNNING',summary:{}}});
    let result;
    try {
      result=await this.locked(caseId,async tx=>{
        // PostgreSQL commits derived source bindings even when the downstream graph is unavailable.
        const inputs=await extractRelationships(tx,caseId),keys=inputs.map(r=>r.stableKey);
        await tx.derivedRelationship.updateMany({where:{caseId,active:true,stableKey:{notIn:keys}},data:{active:false}});
        let created=0;
        for(const input of inputs) {
          const prior=await tx.derivedRelationship.findUnique({where:{caseId_stableKey:{caseId,stableKey:input.stableKey}}});
          if(!prior) {await tx.derivedRelationship.create({data:input});created++;}
          else if(!prior.active)await tx.derivedRelationship.update({where:{id:prior.id},data:{active:true}});
        }
        if(created)await this.event(tx,caseId,E.RELATIONSHIP,{runId:run.id,created});
        const graph=await this.graph(tx,caseId);
        const gaps=await tx.intelligenceGap.findMany({where:{caseId,status:{not:'STALE'}},orderBy:{id:'asc'}});
        const windows=[...new Map(gaps.map(g=>[`${g.timeFrom.toISOString()}:${g.timeTo.toISOString()}`,{from:g.timeFrom.toISOString(),to:g.timeTo.toISOString()}])).values()].sort((a,b)=>a.from.localeCompare(b.from)||a.to.localeCompare(b.to));
        const digest=hashJson({graph,windows,version:R.version,parameters:R});
        const previous=await tx.analysisRun.findFirst({where:{caseId,type,inputDigest:digest,status:'COMPLETED'},orderBy:{startedAt:'desc'}});
        const previousGraph=await tx.graphSyncState.findUnique({where:{caseId}});
        if(previousGraph?.sourceDigest!==digest)await tx.analyticalSignal.updateMany({where:{caseId,active:true},data:{active:false}});
        await tx.analysisRun.update({where:{id:run.id},data:{inputDigest:digest}});
        await tx.graphSyncState.upsert({where:{caseId},create:{caseId,status:'SYNCING',sourceDigest:digest},update:{status:'SYNCING',sourceDigest:digest,error:null}});
        await this.event(tx,caseId,E.SYNC_STARTED,{runId:run.id,rebuild:type==='rebuild'});
        let consistency;
        try {consistency=await graphStore.sync(caseId,graph,type==='rebuild');if(!consistency.consistent)throw new Error('Graph consistency failed');}
        catch {
          await tx.graphSyncState.update({where:{caseId},data:{status:'FAILED',error:'Derived graph unavailable or inconsistent; retry sync/rebuild.'}});
          await tx.analysisRun.update({where:{id:run.id},data:{status:'FAILED',completedAt:new Date(),error:'GRAPH_SYNC_FAILED',summary:toJson({relationships:graph.edges.length})}});
          await this.event(tx,caseId,E.SYNC_FAILED,{runId:run.id});
          await this.audit(tx,caseId,actor,AuditAction.GRAPH_SYNC,{runId:run.id,status:'FAILED'});
          return {runId:run.id,status:'FAILED',error:'GRAPH_SYNC_FAILED',relationships:graph.edges.length};
        }
        await tx.graphSyncState.update({where:{caseId},data:{status:'SYNCED',graphDigest:topologyDigest(graph),syncedAt:new Date(),error:null}});
        await this.event(tx,caseId,type==='rebuild'?E.REBUILT:E.SYNC_COMPLETED,{runId:run.id,nodes:graph.nodes.length,edges:graph.edges.length});
        let summary:Record<string,unknown>={nodes:graph.nodes.length,relationships:graph.edges.length,consistency};
        if(type==='network'||type==='patterns'||type==='full') {
          {
            const network=analyzeNetwork(graph);summary.network=network;
            await this.event(tx,caseId,E.NETWORK,{runId:run.id});
            summary.temporal=activity(graph.edges);await this.event(tx,caseId,E.TEMPORAL,{runId:run.id});
            if(type==='patterns'||type==='full') {
              const patterns=analyzePatterns(graph,network,windows),signalKeys:string[]=[];
              for(const signal of patterns.signals) {
                const stableKey=hashJson(signal);signalKeys.push(stableKey);
                let saved=await tx.analyticalSignal.findUnique({where:{caseId_stableKey:{caseId,stableKey}}});
                if(!saved) {
                  const {relationshipIds,...data}=signal;
                  saved=await tx.analyticalSignal.create({data:{caseId,runId:run.id,stableKey,type:data.type,findingKind:'SIGNAL',entityIds:toJson(data.entityIds),
                    strength:data.strength,confidence:data.confidence,timeFrom:data.timeFrom?new Date(data.timeFrom):null,timeTo:data.timeTo?new Date(data.timeTo):null,
                    rule:data.rule,algorithmVersion:data.version,parameters:toJson(data.parameters),reason:toJson(data.reason),evidenceRefs:toJson(data.evidenceRefs)}});
                  await tx.signalSupport.createMany({data:relationshipIds.map(relationshipId=>({caseId,signalId:saved!.id,relationshipId}))});
                  await this.event(tx,caseId,E.SIGNAL,{runId:run.id,signalId:saved.id,type:saved.type});
                }else if(!saved.active)await tx.analyticalSignal.update({where:{id:saved.id},data:{active:true}});
              }
              await tx.analyticalSignal.updateMany({where:{caseId,active:true,stableKey:{notIn:signalKeys}},data:{active:false}});
              summary.patterns=patterns.summary;summary.signals=patterns.signals.length;
              await this.event(tx,caseId,E.PATTERNS,{runId:run.id,signals:patterns.signals.length});
            }
          }
        }
        // An upstream resolution change must retire signals even when only graph sync is requested.
        await tx.analyticalSignal.updateMany({where:{caseId,active:true,supports:{some:{relationship:{active:false}}}},data:{active:false}});
        summary.signals=await tx.analyticalSignal.count({where:{caseId,active:true}});
        await tx.analysisRun.update({where:{id:run.id},data:{status:'COMPLETED',completedAt:new Date(),summary:toJson(summary)}});
        await this.audit(tx,caseId,actor,type==='sync'||type==='rebuild'?AuditAction.GRAPH_SYNC:AuditAction.BRAIN_ANALYZE,{runId:run.id,type,reused:!!previous,digest});
        const completion={type,digest,nodes:graph.nodes.length,relationships:graph.edges.length,signals:summary.signals,algorithmVersion:R.version};
        const stateDigest=hashJson(completion),lastCompletion=await tx.brainEvent.findFirst({where:{caseId,type:E.COMPLETED},orderBy:{sequence:'desc'}});
        if((lastCompletion?.payload as Record<string,unknown>|undefined)?.stateDigest!==stateDigest)
          await this.event(tx,caseId,E.COMPLETED,{...completion,runId:run.id,stateDigest});
        return {runId:run.id,status:'COMPLETED',reused:!!previous,inputDigest:digest,summary};
      });
    }catch(error) {
      await prisma.analysisRun.update({where:{id:run.id},data:{status:'FAILED',completedAt:new Date(),error:error instanceof ValidationError?'SOURCE_VALIDATION_FAILED':'ANALYSIS_FAILED'}});
      throw error;
    }
    await this.publish(caseId);return result;
  }
  private async read<T>(caseId:string,actor:CaseActor,view:string,work:(tx:Prisma.TransactionClient)=>Promise<T>) {
    await this.access(caseId,actor);
    return this.locked(caseId,async tx=>{const result=await work(tx);await this.audit(tx,caseId,actor,AuditAction.BRAIN_READ,{view});return result;});
  }
  async status(caseId:string,actor:CaseActor) {
    return this.read(caseId,actor,'graph-status',async tx=>{
      const state=await tx.graphSyncState.findUnique({where:{caseId}});
      let graph:CaseGraph;try {graph=await this.current(tx,caseId);} catch(error) {if(error instanceof ValidationError)return {state,consistent:false,sourceStale:true};throw error;}
      try{return {state,...checkConsistency(graph,await graphStore.snapshot(caseId)),sourceStale:false};}
      catch{return {state,consistent:false,graphAvailable:false,sourceStale:false};}
    });
  }
  private async verifiedGraph(tx:Prisma.TransactionClient,caseId:string) {
    const graph=await this.current(tx,caseId);
    if(!checkConsistency(graph,await graphStore.snapshot(caseId)).consistent)throw new ValidationError('Graph differs from authoritative case data; sync/rebuild required');
    return graph;
  }
  graphView(caseId:string,actor:CaseActor,offset=0,limit=50) {
    return this.read(caseId,actor,'graph',async tx=>{const graph=await this.verifiedGraph(tx,caseId),nodes=graph.nodes.slice(offset,offset+limit),ids=new Set(nodes.map(n=>n.id));
      const edges=graph.edges.filter(e=>ids.has(e.sourceId)&&ids.has(e.targetId));
      return {nodes,edges:edges.slice(0,R.maxResults),metadata:{offset,limit,totalNodes:graph.nodes.length,totalEdges:graph.edges.length,truncated:offset+nodes.length<graph.nodes.length||edges.length>R.maxResults,projection:'directed evidence assertions',derived:true}};});
  }
  path(caseId:string,actor:CaseActor,source:string,target:string,hops:number,limit:number,shortest:boolean) {
    return this.read(caseId,actor,'path',async tx=>{const graph=await this.verifiedGraph(tx,caseId);if(!graph.nodes.some(n=>n.id===source)||!graph.nodes.some(n=>n.id===target))throw new NotFoundError('Case entity not found');return paths(graph,source,target,hops,limit,shortest);});
  }
  neighbors(caseId:string,actor:CaseActor,id:string,hops:number,limit:number) {
    return this.read(caseId,actor,'neighborhood',async tx=>{const graph=await this.verifiedGraph(tx,caseId);if(!graph.nodes.some(n=>n.id===id))throw new NotFoundError('Case entity not found');return neighborhood(graph,id,hops,limit);});
  }
  timeline(caseId:string,actor:CaseActor,filter:TimelineFilter) {
    return this.read(caseId,actor,'timeline',async tx=>{const graph=await this.current(tx,caseId);if(filter.entityId&&!graph.nodes.some(n=>n.id===filter.entityId))throw new NotFoundError('Case entity not found');return {...timeline(graph.edges,filter),activity:activity(graph.edges)};});
  }
  network(caseId:string,actor:CaseActor) {return this.read(caseId,actor,'network',async tx=>analyzeNetwork(await this.verifiedGraph(tx,caseId)));}
  signals(caseId:string,actor:CaseActor,offset=0,limit=50,type?:string) {
    return this.read(caseId,actor,'signals',async tx=>{await this.current(tx,caseId);const where={caseId,active:true,...(type?{type}:{})};return {items:await tx.analyticalSignal.findMany({where,include:{supports:true},orderBy:{id:'asc'},skip:offset,take:limit}),total:await tx.analyticalSignal.count({where}),offset,limit};});
  }
  signal(caseId:string,actor:CaseActor,id:string) {
    return this.read(caseId,actor,'signal',async tx=>{const signal=await tx.analyticalSignal.findFirst({where:{caseId,id},include:{supports:{include:{relationship:true}},run:true}});if(!signal)throw new NotFoundError('Signal not found');if(signal.active)await this.current(tx,caseId);return {...signal,historical:!signal.active};});
  }
  runs(caseId:string,actor:CaseActor,offset=0,limit=50) {return this.read(caseId,actor,'runs',async tx=>({items:await tx.analysisRun.findMany({where:{caseId},orderBy:{startedAt:'desc'},skip:offset,take:limit}),total:await tx.analysisRun.count({where:{caseId}}),offset,limit}));}
}
export const brainService=new BrainService();
