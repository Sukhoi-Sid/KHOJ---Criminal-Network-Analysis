import { randomUUID } from 'node:crypto';
import { prisma } from '../src/core/db';
import type { CaseActor } from '../src/modules/auth/policies';
import { evidenceStoreService } from '../src/modules/evidence-store/evidence.service';
import { documentIntelligenceService } from '../src/modules/document-intelligence/mention.service';
import { intelligenceService } from '../src/modules/intelligence-requirements/intelligence.service';
import { entityResolutionService } from '../src/modules/entity-resolution/resolution.service';
import { sourceAdapters } from '../src/modules/data-exchange/adapters';

export const DEMO_PHONES=['9876543210','9000000001','9000000002','9000000003','9000000004','9000000005','9000000006','9000000007'];
export const DEMO_ACCOUNTS=['001234567890','001234567891','001234567892'];
export function mergedDemoRows(source:string):Record<string,unknown>[] {
  if(source==='mock-cdr') {
    const pairs=[[0,1],[0,2],[1,2],[2,3],[3,4],[3,5],[4,5],[0,6],[0,7],[1,0]];
    const records:Record<string,unknown>[]=pairs.map(([a,b],i)=>({callId:`SYNTHETIC-CALL-${i}`,phone:DEMO_PHONES[a],counterpart:DEMO_PHONES[b],durationSeconds:45,
      ...(a===0?{subscriber:'Rahul Sharma'}:{}),timestamp:`2026-09-01T${String(i).padStart(2,'0')}:00:00Z`}));
    for(let i=0;i<6;i++)records.push({callId:`SYNTHETIC-SPIKE-${i}`,phone:DEMO_PHONES[0],counterpart:DEMO_PHONES[1],subscriber:'Rahul Sharma',durationSeconds:30,timestamp:`2026-09-02T10:0${i}:00Z`});
    return records;
  }
  if(source==='mock-financial') return [
    ...[0,1,2,3].map(i=>({transactionId:`SYNTHETIC-BASE-${i}`,account:DEMO_ACCOUNTS[0],counterparty:DEMO_ACCOUNTS[1],amountINR:100,timestamp:`2026-09-01T0${i}:30:00Z`,accountHolder:'Rahul Sharma',phone:DEMO_PHONES[0],bank:'Synthetic Bank',organization:'Example Company',organizationRelation:'WORKS_FOR'})),
    {transactionId:'SYNTHETIC-LARGE',account:DEMO_ACCOUNTS[0],counterparty:DEMO_ACCOUNTS[1],amountINR:50000,timestamp:'2026-09-02T10:02:00Z',accountHolder:'Rahul Sharma',phone:DEMO_PHONES[0],bank:'Synthetic Bank'},
    {transactionId:'SYNTHETIC-CHAIN',account:DEMO_ACCOUNTS[1],counterparty:DEMO_ACCOUNTS[2],amountINR:100,timestamp:'2026-09-02T10:04:00Z'},
    {transactionId:'SYNTHETIC-CIRCLE',account:DEMO_ACCOUNTS[2],counterparty:DEMO_ACCOUNTS[0],amountINR:100,timestamp:'2026-09-02T10:06:00Z'},
  ];
  if(source==='mock-location')return [0,1].flatMap(i=>[
    {observationId:`SYNTHETIC-RAHUL-${i}`,location:'Gandhi Nagar Colony',observedPerson:'Rahul Sharma',phone:DEMO_PHONES[0],timestamp:`2026-09-02T${10+i}:03:00Z`},
    {observationId:`SYNTHETIC-AMIT-${i}`,location:'Gandhi Nagar Colony',observedPerson:'Amit Kumar',phone:'9123456780',timestamp:`2026-09-02T${10+i}:04:00Z`},
  ]);
  if(source==='mock-vehicle')return [{recordId:'SYNTHETIC-OWNER',registration:'MP04AB1234',registeredOwner:'Rahul Sharma',phone:DEMO_PHONES[0],asOf:'2026-09-02T10:00:00Z'}];
  return [];
}

export async function seedMergedDemo(inv:CaseActor,sup:CaseActor,reference='REF-2026-CROSSLINK') {
  const kase=await prisma.case.upsert({where:{caseId:reference},update:{},create:{caseId:reference,title:'Operation Crosslink',description:'Synthetic merged Phase 5+6 demonstration.',classification:'confidential',createdById:inv.id,intelligenceState:{create:{summary:{}}}}});
  for(const actor of [inv,sup])await prisma.caseAssignment.upsert({where:{caseId_userId:{caseId:kase.id,userId:actor.id}},update:{},create:{caseId:kase.id,userId:actor.id,role:actor.id===inv.id?'investigator':'supervisor'}});
  const filename='synthetic-merged-crosslink.txt';
  let document=await prisma.document.findFirst({where:{caseId:kase.id,filename}});
  if(!document)document=(await evidenceStoreService.uploadDocument({caseId:kase.id,filename,mimeType:'text/plain',uploadedById:inv.id,actorEmail:inv.email,
    buffer:Buffer.from('SYNTHETIC DATA ONLY\nReported vehicle theft and online payment fraud.\nFIR No: CROSSLINK-MERGED-2026\nIncident window: 01 September 2026 to 02 September 2026\nComplainant: Rahul Sharma\nPhone: +91 98765 43210\nAccount: 001234567890\nVehicle: MP04AB1234\nOrganization: Example Company\nAccused: Amit Kumar\nThe scammer caller used 9876543210 in online fraud.\nThe payment was transferred to account no. 001234567890 in the scam.\nVehicle MP04AB1234 was stolen during the theft.\nCCTV at Gandhi Nagar Colony may show the incident.') })).document;
  await documentIntelligenceService.processDocument(kase.id,document.id,inv);
  const analysis=await intelligenceService.analyze(kase.id,inv);
  for(const source of ['mock-cdr','mock-financial','mock-location','mock-vehicle']) {
    const gap=analysis.gaps.find(g=>g.sourceId===source&&g.status!=='STALE');if(!gap)throw new Error(`Demo requirement missing: ${source}`);
    if(gap.status==='OPEN')await intelligenceService.review(kase.id,gap.id,inv,'select','Synthetic scoped evidence for Operation Crosslink.');
    let r=await intelligenceService.createRequest(kase.id,gap.id,inv);
    if(r.status==='DRAFT')r=await intelligenceService.submit(kase.id,r.id,inv);
    if(r.status==='PENDING_AUTHORIZATION')r=await intelligenceService.authorize(kase.id,r.id,sup,true,'Independent approval of fictional demonstration records.');
    if(r.status==='AUTHORIZED'||r.status==='FAILED') {
      const adapter=sourceAdapters.get(source)!,original=adapter.fetchResponse;
      adapter.fetchResponse=async receipt=>({...await original.call(adapter,receipt),records:mergedDemoRows(source)});
      try{r=await intelligenceService.dispatch(kase.id,r.id,inv);}finally{adapter.fetchResponse=original;}
    }
    if(r.status==='RECEIVED')await intelligenceService.complete(kase.id,r.id,inv);
  }
  await entityResolutionService.integrate(kase.id,inv);
  // The controlled fixture explicitly denotes the same site. Preserve Phase 4's mandatory text-identity review.
  for(const candidate of (await entityResolutionService.candidates(kase.id,inv)).items) {
    if(candidate.status==='REVIEW_REQUIRED'&&['location','organization'].includes(candidate.left.entityType)&&candidate.left.normalizedValue===candidate.right.normalizedValue) {
      const current=await entityResolutionService.candidate(kase.id,candidate.id,inv);
      if(current.status==='REVIEW_REQUIRED')await entityResolutionService.review(kase.id,current.id,inv,{decision:'accept',reason:'Controlled synthetic fixture: verified same named site/organization across sources.',expectedRevision:current.revision,idempotencyKey:randomUUID()});
    }
  }
  return kase;
}
