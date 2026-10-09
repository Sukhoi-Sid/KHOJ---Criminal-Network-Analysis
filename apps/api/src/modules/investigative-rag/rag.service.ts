import {createHash,randomUUID} from 'node:crypto';
import {AuditAction,AuditResourceType,Permission,type InvestigativeAnswer,type InvestigativeAskRequest,type InvestigativeCitation,type InvestigativeClaim,type InvestigativeEntity,type InvestigativeIntent,type EvidenceRef} from '@sih/shared';
import {prisma} from '../../core/db';
import {env} from '../../core/env';
import {NotFoundError,ValidationError} from '../../core/errors';
import type {CaseActor} from '../auth/policies';
import {assertDerivedCasePermission} from '../auth/policies';
import {auditService} from '../audit/audit.service';
import {brainService} from '../intelligence-brain/brain.service';
import {analyzeIntent,injectionLike} from './intent';
import {createGroundedProvider,DeterministicGroundedProvider,type IGroundedAnswerProvider} from './provider';

type EntityRow={id:string;entityType:string;displayLabel:string;confidence:number;resolutionStatus:string};
type RelationRow={id:string;sourceId:string;targetId:string;type:string;findingKind:string;confidence:number;occurredAt:Date|null;observedAt:Date|null;sourceSystem:string;evidenceRefs:unknown;source:EntityRow;target:EntityRow};
const maxClaims=20;
const idFor=(kind:string,value:string)=>`${kind.toLowerCase()}:${createHash('sha256').update(value).digest('hex').slice(0,16)}`;
const refs=(value:unknown):EvidenceRef[]=>Array.isArray(value)?value.filter((r):r is EvidenceRef=>!!r&&typeof r==='object'&&typeof (r as EvidenceRef).evidenceRecordId==='string'):[];
const signalEntityIds=(value:unknown):string[]=>Array.isArray(value)?value.filter((id):id is string=>typeof id==='string'):[];

export class InvestigativeRagService {
  constructor(private readonly provider:IGroundedAnswerProvider=createGroundedProvider()){}
  private citation(map:Map<string,InvestigativeCitation>,citation:Omit<InvestigativeCitation,'id'>,key:string) {
    const id=idFor(citation.kind,key);if(!map.has(id))map.set(id,{id,...citation});return id;
  }
  private relationClaim(row:RelationRow,citations:Map<string,InvestigativeCitation>,kind:'FACT'|'INFERENCE'='FACT'):InvestigativeClaim {
    const ids=[this.citation(citations,{kind:'RELATIONSHIP',label:`${row.source.displayLabel} ${row.type} ${row.target.displayLabel}`,relationshipId:row.id},row.id)];
    for(const ref of refs(row.evidenceRefs))ids.push(this.citation(citations,{kind:'EVIDENCE',label:`Source ${ref.sourceRecordId}`,evidenceRecordId:ref.evidenceRecordId,documentId:ref.documentId,sourceRecordId:ref.sourceRecordId,sourceLocation:ref.sourceLocation},`${ref.evidenceRecordId}:${ref.sourceRecordId}:${JSON.stringify(ref.sourceLocation)}`));
    return {id:idFor('claim',row.id),findingKind:kind,statement:`${row.source.displayLabel} ${row.type.replaceAll('_',' ').toLowerCase()} ${row.target.displayLabel}.`,confidence:row.confidence,citationIds:ids};
  }
  private resolveEntities(question:string,rows:EntityRow[],requested:string[]=[],last?:string) {
    const available=new Map(rows.map(r=>[r.id,r]));
    const explicit=[...new Set([...requested,...(last?[last]:[])])];
    for(const entityId of explicit)if(!available.has(entityId))throw new NotFoundError('Case entity not found');
    const q=question.toLocaleLowerCase();
    const named=rows.filter(r=>r.displayLabel.length>=3&&q.includes(r.displayLabel.toLocaleLowerCase())).map(r=>r.id);
    return [...new Set([...requested,...named,...(requested.length===0&&named.length===0&&last?[last]:[])])].map(id=>available.get(id)!);
  }
  private async compose(input:{intent:InvestigativeIntent;facts:InvestigativeClaim[];inferences:InvestigativeClaim[];signals:InvestigativeClaim[];limitations:string[]}) {
    let fallbackUsed=false,answer:string;
    try {
      let timer:NodeJS.Timeout|undefined;
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('RAG provider timeout')),env.RAG_TIMEOUT_MS);});
      const output=await Promise.race([this.provider.compose(input),timeout]).finally(()=>{if(timer)clearTimeout(timer);});
      if(!output||typeof output.answer!=='string'||!output.answer.trim()||output.answer.length>10000)throw new Error('Malformed grounded provider response');
      answer=output.answer.trim();
    } catch {
      fallbackUsed=true;input.limitations.push('Configured answer generation was unavailable; deterministic grounded output was returned.');
      answer=(await new DeterministicGroundedProvider().compose(input)).answer;
    }
    return {answer,fallbackUsed};
  }
  async ask(caseId:string,actor:CaseActor,input:InvestigativeAskRequest):Promise<InvestigativeAnswer> {
    await assertDerivedCasePermission(caseId,actor,Permission.BRAIN_READ);
    const requestId=randomUUID(),intent=analyzeIntent(input.question),retrieval=new Set<string>(),limitations:string[]=[];
    const citations=new Map<string,InvestigativeCitation>(),facts:InvestigativeClaim[]=[],inferences:InvestigativeClaim[]=[],signals:InvestigativeClaim[]=[];
    const questionHash=createHash('sha256').update(input.question).digest('hex');
    if(injectionLike(input.question)) {
      limitations.push('The question contains instruction-like content. Retrieved evidence is treated only as data, and no system prompt, secret, SQL or Cypher is exposed or executed.');
      const composed=await this.compose({intent,facts,inferences,signals,limitations});
      await this.audit(caseId,actor,requestId,questionHash,intent,[],composed.fallbackUsed?'FALLBACK':'COMPLETED');
      return this.answer(requestId,intent,composed.answer,facts,inferences,signals,citations,[],retrieval,limitations,composed.fallbackUsed);
    }
    const [entityRows,relations,signalRows]=await Promise.all([
      prisma.canonicalEntity.findMany({where:{caseId,active:true},select:{id:true,entityType:true,displayLabel:true,confidence:true,resolutionStatus:true},orderBy:{id:'asc'}}),
      prisma.derivedRelationship.findMany({where:{caseId,active:true},include:{source:{select:{id:true,entityType:true,displayLabel:true,confidence:true,resolutionStatus:true}},target:{select:{id:true,entityType:true,displayLabel:true,confidence:true,resolutionStatus:true}}},orderBy:{id:'asc'}}),
      prisma.analyticalSignal.findMany({where:{caseId,active:true},orderBy:{id:'asc'},take:200}),
    ]);retrieval.add('entities');
    const selected=this.resolveEntities(input.question,entityRows,input.entityIds??[],input.conversation?.lastEntityId);
    const selectedIds=new Set(selected.map(e=>e.id));
    const relevantRelations=relations.filter(r=>!selectedIds.size||selectedIds.has(r.sourceId)||selectedIds.has(r.targetId));
    const addRelations=(rows:RelationRow[])=>{retrieval.add('relationships');for(const row of rows.slice(0,maxClaims))facts.push(this.relationClaim(row,citations));};
    const addSignals=(predicate:(type:string)=>boolean)=>{retrieval.add('signals');for(const row of signalRows.filter(s=>predicate(s.type)&&(!selectedIds.size||signalEntityIds(s.entityIds).some(id=>selectedIds.has(id)))).slice(0,maxClaims)){
      const evidence=refs(row.evidenceRefs),citationIds=[this.citation(citations,{kind:'SIGNAL',label:row.type,signalId:row.id},row.id),...evidence.map(ref=>this.citation(citations,{kind:'EVIDENCE',label:`Source ${ref.sourceRecordId}`,evidenceRecordId:ref.evidenceRecordId,documentId:ref.documentId,sourceRecordId:ref.sourceRecordId,sourceLocation:ref.sourceLocation},`${ref.evidenceRecordId}:${ref.sourceRecordId}:${JSON.stringify(ref.sourceLocation)}`))];
      const reason=row.reason as {description?:unknown;metrics?:unknown;caution?:unknown};signals.push({id:idFor('signal-claim',row.id),findingKind:'SIGNAL',statement:typeof reason?.description==='string'?reason.description:`${row.type.replaceAll('_',' ')} was detected by ${row.rule}.`,confidence:row.confidence,citationIds});
    }};
    if(intent==='CONNECTION') {
      if(selected.length<2)limitations.push('Two current case entities are required for a connection query. Supply entityIds or use their exact labels.');
      else try {const result=await brainService.path(caseId,actor,selected[0].id,selected[1].id,4,20,true);retrieval.add('graph-path');const path=result.paths[0];
        if(!path)limitations.push('No bounded path was found between the selected entities.');else {for(const edge of path.edges){const stored=relations.find(r=>r.id===edge.id);if(stored)facts.push(this.relationClaim(stored,citations));}inferences.push({id:idFor('path',path.nodes.map(n=>n.id).join(':')),findingKind:'INFERENCE',statement:`A ${path.hopCount}-hop analytical path connects ${selected[0].displayLabel} and ${selected[1].displayLabel}.`,confidence:null,citationIds:path.edges.flatMap(e=>[this.citation(citations,{kind:'RELATIONSHIP',label:e.type,relationshipId:e.id},e.id)])});}}
      catch {limitations.push('The derived graph is unavailable or stale; persisted evidence-bound relationships are returned instead.');addRelations(relevantRelations);}
    } else if(intent==='KEY_ENTITY') {
      try {const network=await brainService.network(caseId,actor);retrieval.add('network-metrics');const metrics=[...network.metrics].filter(m=>!selectedIds.size||selectedIds.has(m.entityId)).sort((a,b)=>b.betweenness-a.betweenness||b.degree-a.degree||b.pageRank-a.pageRank).slice(0,selectedIds.size?maxClaims:3);
        for(const metric of metrics){const entity=entityRows.find(e=>e.id===metric.entityId)!;const supporting=relations.filter(r=>r.sourceId===metric.entityId||r.targetId===metric.entityId).slice(0,10);const metricCitation=this.citation(citations,{kind:'NETWORK_METRIC',label:`degree=${metric.degree}, betweenness=${metric.betweenness}, PageRank=${metric.pageRank}, ${metric.communityId}`,entityId:metric.entityId},`${metric.entityId}:${network.version}`);const relCitations=supporting.flatMap(r=>this.relationClaim(r,citations).citationIds);inferences.push({id:idFor('metric',metric.entityId),findingKind:'INFERENCE',statement:`${entity.displayLabel} is network-relevant with degree ${metric.degree}, betweenness ${metric.betweenness.toFixed(4)} and PageRank ${metric.pageRank.toFixed(4)}; this is structural relevance, not guilt.`,confidence:null,citationIds:[metricCitation,...relCitations]});}}
      catch {limitations.push('Network metrics are unavailable because the derived graph is unavailable or inconsistent.');addRelations(relevantRelations);}
    } else if(intent==='TEMPORAL') {
      try {const result=await brainService.timeline(caseId,actor,{entityId:selected[0]?.id,from:input.from,to:input.to,offset:0,limit:50});retrieval.add('timeline');const timelineRelations=result.items.map(item=>relations.find(r=>r.id===item.id)).filter(row=>row!==undefined);addRelations(timelineRelations);if(!result.total)limitations.push('No timestamped events matched the requested case scope and window.');}
      catch {limitations.push('The requested temporal window or entity could not be retrieved.');}
    } else if(intent==='COMMUNICATION') {addRelations(relevantRelations.filter(r=>['CALLED','COMMUNICATED_WITH','ASSOCIATED_WITH_PHONE'].includes(r.type)));addSignals(t=>/COMMUNICATION|CONNECTION/.test(t));
    } else if(intent==='FINANCIAL') {addRelations(relevantRelations.filter(r=>['TRANSFERRED_TO','ASSOCIATED_WITH_ACCOUNT'].includes(r.type)));addSignals(t=>/TRANSACTION|FINANCIAL|TRANSFER|FLOW/.test(t));
    } else if(intent==='LOCATION') {addRelations(relevantRelations.filter(r=>['SEEN_AT','VISITED'].includes(r.type)));addSignals(t=>/LOCATION/.test(t));
    } else if(intent==='ENTITY_SIGNALS') {addSignals(()=>true);
    } else if(intent==='EVIDENCE') {addRelations(selected.length>=2?relations.filter(r=>(r.sourceId===selected[0].id&&r.targetId===selected[1].id)||(r.sourceId===selected[1].id&&r.targetId===selected[0].id)):relevantRelations);
    } else if(intent==='UNCERTAINTY') {retrieval.add('resolution-conflicts');const unresolved=await prisma.resolutionCandidate.findMany({where:{caseId,active:true,status:{in:['UNRESOLVED','REVIEW_REQUIRED']}},include:{left:true,right:true},take:maxClaims});for(const row of unresolved){const left=this.citation(citations,{kind:'ENTITY',label:row.left.rawValue},row.leftId),right=this.citation(citations,{kind:'ENTITY',label:row.right.rawValue},row.rightId);inferences.push({id:idFor('uncertain',row.id),findingKind:'UNKNOWN',statement:`Identity resolution remains ${row.status.toLowerCase().replace('_',' ')} between “${row.left.rawValue}” and “${row.right.rawValue}”; conflicts are preserved.`,confidence:row.score,citationIds:[left,right]});}if(!unresolved.length)limitations.push('No active unresolved or review-required identity conflicts were found.');
    } else {addRelations(relevantRelations);addSignals(()=>true);}
    if(intent==='GUILT_REQUEST') {addRelations(relevantRelations);addSignals(()=>true);limitations.unshift('The system cannot determine guilt or make a law-enforcement decision. Facts, derived relationships and signals require human investigation and legal evaluation.');}
    if(!facts.length&&!inferences.length&&!signals.length&&!limitations.length)limitations.push('Insufficient authorized evidence is available to answer this question.');
    const composed=await this.compose({intent,facts,inferences,signals,limitations});
    await this.audit(caseId,actor,requestId,questionHash,intent,[...retrieval],composed.fallbackUsed?'FALLBACK':'COMPLETED');
    return this.answer(requestId,intent,composed.answer,facts,inferences,signals,citations,selected,retrieval,limitations,composed.fallbackUsed);
  }
  private answer(requestId:string,intent:InvestigativeIntent,answer:string,facts:InvestigativeClaim[],inferences:InvestigativeClaim[],signals:InvestigativeClaim[],citations:Map<string,InvestigativeCitation>,entities:EntityRow[],retrieval:Set<string>,limitations:string[],fallbackUsed:boolean):InvestigativeAnswer {
    const all=[...facts,...inferences,...signals];return {requestId,intent,answer,facts,inferences,signals,citations:[...citations.values()],entities:entities.map(e=>({id:e.id,type:e.entityType,label:e.displayLabel} as InvestigativeEntity)),answerQuality:{groundedClaims:all.filter(c=>c.citationIds.length).length,totalClaims:all.length,retrievalTypes:[...retrieval],provider:this.provider.name,model:this.provider.model,fallbackUsed},limitations:[...new Set(limitations)],generatedAt:new Date().toISOString()};
  }
  private audit(caseId:string,actor:CaseActor,requestId:string,questionHash:string,intent:InvestigativeIntent,retrievalTypes:string[],status:string){return auditService.emit({actorId:actor.id,actorEmail:actor.email,action:AuditAction.BRAIN_READ,resourceType:AuditResourceType.CASE_GRAPH,resourceId:requestId,caseId,ipAddress:actor.ipAddress,metadata:{view:'investigative-rag',requestId,questionHash,intent,retrievalTypes,status,provider:this.provider.name,model:this.provider.model}});}
  async explain(caseId:string,actor:CaseActor,kind:'relationship'|'signal'|'entity'|'evidence',id:string) {
    await assertDerivedCasePermission(caseId,actor,Permission.BRAIN_READ);let result:unknown;
    if(kind==='relationship')result=await prisma.derivedRelationship.findFirst({where:{caseId,id},include:{source:true,target:true,signalSupports:{select:{signalId:true}}}});
    else if(kind==='signal')result=await prisma.analyticalSignal.findFirst({where:{caseId,id},include:{supports:{include:{relationship:true}},run:{select:{id:true,type:true,algorithmVersion:true,parameters:true,status:true}}}});
    else if(kind==='entity')result=await prisma.canonicalEntity.findFirst({where:{caseId,id},select:{id:true,entityType:true,displayLabel:true,resolutionStatus:true,confidence:true,sources:{select:{record:{select:{id:true,sourceKind:true,sourceId:true,documentId:true,evidenceRecordId:true,confidence:true,reliabilityTier:true,sourceLocation:true}}}}}});
    else result=await prisma.evidenceRecord.findFirst({where:{caseId,id},select:{id:true,sourceType:true,sourceRecordId:true,reliabilityTier:true,createdAt:true,document:{select:{id:true,filename:true,mimeType:true,createdAt:true}},provenance:{select:{originSource:true,receivedAt:true,parentEvidenceId:true}}}});
    if(!result)throw new NotFoundError('Case-scoped explanation source not found');
    const requestId=randomUUID();await this.audit(caseId,actor,requestId,createHash('sha256').update(`${kind}:${id}`).digest('hex'),'EVIDENCE',[kind],'COMPLETED');return {requestId,kind,result};
  }
}
export const investigativeRagService=new InvestigativeRagService();
