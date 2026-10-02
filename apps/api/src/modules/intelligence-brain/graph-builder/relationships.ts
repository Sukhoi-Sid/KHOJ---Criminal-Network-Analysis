import type { Prisma, NormalizedSourceRecord, CanonicalEntity } from '@prisma/client';
import { type EntityType, type EntityIdentifiers } from '@sih/shared';
import { hashJson, toJson } from '../../../core/json';
import { ValidationError } from '../../../core/errors';
import { collectSourceRecords } from '../../entity-resolution/integration';
import { valueNormalizers } from '../../entity-resolution/normalization';
import { evidenceStoreService } from '../../evidence-store/evidence.service';
import { BRAIN_RULES as R } from '../rules';
import type { EvidenceRef, RelationshipType } from '../types';

type Input = Omit<Prisma.DerivedRelationshipUncheckedCreateInput,'id'|'createdAt'|'updatedAt'>;
// An explicit timezone is required. A retrieval timestamp is never an occurrence timestamp.
export function sourceTime(value:unknown):Date|null {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const [year,month,day]=value.slice(0,10).split('-').map(Number),calendar=new Date(Date.UTC(year,month-1,day));
  if(calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day)return null;
  const n=Date.parse(value);return Number.isFinite(n)?new Date(n):null;
}

export async function extractRelationships(tx:Prisma.TransactionClient,caseId:string):Promise<Input[]> {
  const current=await collectSourceRecords(tx,caseId); // includes existing returned-package hash/scope verification
  const records=await tx.normalizedSourceRecord.findMany({where:{caseId,active:true},include:{evidenceRecord:true}});
  const documentIds=[...new Set(records.filter(r=>r.sourceKind==='MENTION'&&r.documentId).map(r=>r.documentId!))];
  for(const document of await tx.document.findMany({where:{caseId,id:{in:documentIds}}}))await evidenceStoreService.verifyDocumentBlob(document);
  if(JSON.stringify(current.map(r=>r.sourceKey).sort())!==JSON.stringify(records.map(r=>r.sourceKey).sort())) throw new ValidationError('Integrate current Phase 4 sources before running the Brain');
  const originals=new Map(current.map(r=>[r.sourceKey,r]));
  for(const r of records) {
    const original=originals.get(r.sourceKey)!;
    // JSONB reorders object keys; compare canonical JSON rather than insertion order.
    const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
    if(r.rawValue!==original.rawValue||r.normalizedValue!==original.normalizedValue||hashJson(canonical(r.attributes))!==hashJson(canonical(original.attributes))||hashJson(canonical(r.identifiers))!==hashJson(canonical(original.identifiers))) throw new ValidationError('Normalized snapshot differs from authoritative source');
  }
  const entities=await tx.canonicalEntity.findMany({where:{caseId,active:true},include:{sources:true}});
  if(entities.length>R.maxNodes) throw new ValidationError('Case exceeds graph node limit');
  const entityByRecord=new Map<string,CanonicalEntity>();
  for(const e of entities) for(const link of e.sources) entityByRecord.set(link.recordId,e);
  const refs=(rows:NormalizedSourceRecord[]):EvidenceRef[]=>rows.flatMap(r=>r.evidenceRecordId?[{
    evidenceRecordId:r.evidenceRecordId,documentId:r.documentId,sourceRecordId:r.id,sourceLocation:r.sourceLocation,
    contentHash:String((r.sourceLocation as Record<string,unknown>).contentHash??''),
  }]:[]);
  const output=new Map<string,Input>();
  const emit=(source:NormalizedSourceRecord,target:NormalizedSourceRecord,type:RelationshipType,options:{occurredAt?:Date|null;observedAt?:Date|null;endAt?:Date|null;attributes?:Record<string,unknown>}={})=>{
    const from=entityByRecord.get(source.id),to=entityByRecord.get(target.id);
    if(!from||!to) return;
    const evidenceRefs=refs([source,target]);if(!evidenceRefs.length) return;
    const stableKey=hashJson({sourceKey:source.sourceKey,targetKey:target.sourceKey,from:from.id,to:to.id,type,version:R.version});
    output.set(stableKey,{caseId,stableKey,sourceId:from.id,targetId:to.id,type,direction:'DIRECTED',findingKind:'FACT',
      confidence:Math.min(source.confidence,target.confidence),strength:1,sourceSystem:source.sourceId??'document-intelligence',
      sourceRecordIds:toJson([source.id,target.id]),evidenceRefs:toJson(evidenceRefs),extractionMethod:'deterministic-source-fields',
      algorithmVersion:R.version,attributes:toJson({sourceAssertion:true,reliabilityTier:source.reliabilityTier,...options.attributes}),
      occurredAt:options.occurredAt??null,observedAt:options.observedAt??null,endAt:options.endAt??null,active:true});
    if(output.size>R.maxEdges) throw new ValidationError('Case exceeds relationship limit');
  };
  const caseRecord=records.find(r=>r.sourceKind==='CASE_METADATA');
  const groupKey=(r:NormalizedSourceRecord)=>r.responseId?`${r.responseId}:${String((r.sourceLocation as Record<string,unknown>).jsonPointer).split('/').slice(0,3).join('/')}`:`document:${r.documentId}`;
  const groups=new Map<string,typeof records>();for(const r of records) {const key=groupKey(r);groups.set(key,[...(groups.get(key)??[]),r]);}
  const field=(r:NormalizedSourceRecord)=>String((r.sourceLocation as Record<string,unknown>).jsonPointer??'').split('/').at(-1);
  for(const r of records.filter(r=>r.entityType==='person')) {
    if(caseRecord && r.sourceKind==='MENTION') emit(r,caseRecord,'MENTIONED_IN');
    const ids=r.identifiers as EntityIdentifiers;
    for(const [attribute,type,relationship] of [['phone','phone','ASSOCIATED_WITH_PHONE'],['vehicle','vehicle','ASSOCIATED_WITH_VEHICLE'],['account','money','ASSOCIATED_WITH_ACCOUNT'],['organization','organization','ASSOCIATED_WITH']] as const) {
      for(const value of ids[attribute]??[]) {
        const local=(groups.get(groupKey(r))??[]).filter(t=>t.entityType===type&&t.normalizedValue===valueNormalizers[type](value).value);
        // Ambiguous local endpoints are never selected arbitrarily.
        if(new Set(local.map(t=>entityByRecord.get(t.id)?.id)).size===1 && local.length) emit(r,local[0],relationship);
      }
    }
  }
  for(const group of groups.values()) {
    if(!group[0].responseId) continue;
    const row=group[0].attributes as Record<string,unknown>;
    const at=sourceTime(row.timestamp??row.occurredAt),observed=sourceTime(row.observedAt??row.asOf??row.timestamp);
    const from=(f:string)=>group.find(r=>field(r)===f);
    const pair=(a:string,b:string,type:RelationshipType,attributes:Record<string,unknown>={})=>{
      const left=from(a),right=from(b);if(!left||!right) return;
      if(['phone','vehicle','money'].includes(left.entityType)&&!left.validIdentifier) return;
      if(['phone','vehicle','money'].includes(right.entityType)&&!right.validIdentifier) return;
      emit(left,right,type,{occurredAt:['CALLED','TRANSFERRED_TO'].includes(type)?at:null,
        observedAt:['SEEN_AT','VISITED','OWNS'].includes(type)?observed:null,attributes});
    };
    pair('phone','counterpart','CALLED',{durationSeconds:typeof row.durationSeconds==='number'&&row.durationSeconds>=0?row.durationSeconds:null});
    pair('account','counterparty','TRANSFERRED_TO',{amount:typeof row.amountINR==='number'&&Number.isFinite(row.amountINR)&&row.amountINR>=0?row.amountINR:null,currency:'INR',transactionId:row.transactionId??null});
    pair('registeredOwner','registration','OWNS',{assertion:'registered owner reported by source'});
    pair('accountHolder','account','ASSOCIATED_WITH_ACCOUNT');
    pair('subscriber','phone','ASSOCIATED_WITH_PHONE');
    pair('reportedName','reference','MENTIONED_IN');
    for(const who of ['observedPerson','phone','vehicle']) pair(who,'location',row.observationType==='visited'?'VISITED':'SEEN_AT',{observationId:row.observationId??null});
    if(row.organizationRelation==='WORKS_FOR'||row.organizationRelation==='MEMBER_OF') pair('accountHolder','organization',row.organizationRelation);
  }
  return [...output.values()];
}
