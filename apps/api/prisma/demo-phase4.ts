import assert from 'node:assert/strict';
import { UserRole } from '@sih/shared';
import { prisma } from '../src/core/db';
import { registerCaseIntelligenceStateSubscriber } from '../src/modules/case-platform/intelligence-state.subscriber';
import { evidenceStoreService } from '../src/modules/evidence-store/evidence.service';
import { documentIntelligenceService } from '../src/modules/document-intelligence/mention.service';
import { intelligenceService } from '../src/modules/intelligence-requirements/intelligence.service';
import { sourceAdapters } from '../src/modules/data-exchange/adapters';
import { entityResolutionService } from '../src/modules/entity-resolution/resolution.service';

async function main() {
  registerCaseIntelligenceStateSubscriber();
  const investigator=await prisma.user.findUniqueOrThrow({where:{email:'investigator@ncrb.demo'}});
  const supervisor=await prisma.user.findUniqueOrThrow({where:{email:'supervisor@ncrb.demo'}});
  const inv={id:investigator.id,email:investigator.email,role:UserRole.INVESTIGATOR};
  const sup={id:supervisor.id,email:supervisor.email,role:UserRole.SUPERVISOR};
  const existing=await prisma.case.findMany({where:{caseId:{in:['REF-2026-DEMO-THEFT','REF-2026-DEMO-SCAM']}}});
  for(const kase of existing) await entityResolutionService.integrate(kase.id,inv);
  const kase=await prisma.case.upsert({where:{caseId:'REF-2026-DEMO-RESOLUTION'},update:{},create:{
    caseId:'REF-2026-DEMO-RESOLUTION',title:'Synthetic theft and online scam identity resolution',
    description:'Fictional Phase 4 identities, no real people or departmental data.',createdById:inv.id,
    classification:'restricted',jurisdiction:'Demo Jurisdiction',intelligenceState:{create:{summary:{}}},
  }});
  for(const actor of [inv,sup]) await prisma.caseAssignment.upsert({where:{caseId_userId:{caseId:kase.id,userId:actor.id}},update:{},create:{caseId:kase.id,userId:actor.id,role:actor.id===inv.id?'investigator':'supervisor'}});
  const filename='synthetic-phase4-identities.txt';
  let document=await prisma.document.findFirst({where:{caseId:kase.id,filename}});
  if(!document) document=(await evidenceStoreService.uploadDocument({caseId:kase.id,filename,mimeType:'text/plain',uploadedById:inv.id,actorEmail:inv.email,
    buffer:Buffer.from('SYNTHETIC DEMONSTRATION ONLY\nFIR No: DEMO-RESOLUTION-2026\nIncident window: 01 September 2026 to 02 September 2026\nComplainant: Rahul Sharma\nPhone: +91 98765 43210\nDOB: 1990-01-01\nAddress: Gandhi Nagar\nAccused: Amit Kumar\nThe scammer caller used phone 9876543210 for online fraud.\nVehicle MP04AB1234 was stolen.\nWitness: Rahul Sharma\nPhone: 9123456780\nDOB: 1992-02-02\nAddress: Shastri Nagar\nVehicle MP-04-AB-1234 was observed.') })).document;
  await documentIntelligenceService.processDocument(kase.id,document.id,inv);
  const analysis=await intelligenceService.analyze(kase.id,inv);
  for(const source of ['mock-cdr','mock-criminal-history']) {
    const gap=analysis.gaps.find(g=>g.sourceId===source && g.status!=='STALE'); assert(gap,`Missing ${source} gap`);
    if(gap.status==='OPEN') await intelligenceService.review(kase.id,gap.id,inv,'select','Synthetic Phase 4 demonstration: scope verified.');
    let r=await intelligenceService.createRequest(kase.id,gap.id,inv);
    if(r.status==='DRAFT') r=await intelligenceService.submit(kase.id,r.id,inv);
    if(r.status==='PENDING_AUTHORIZATION') r=await intelligenceService.authorize(kase.id,r.id,sup,true,'Independent synthetic demonstration approval.');
    if(r.status==='AUTHORIZED' || r.status==='FAILED') {
      // Extend only this synthetic receipt inside the demo process; reuse the existing adapter and authorized dispatch.
      const adapter=sourceAdapters.get(source)!; const original=adapter.fetchResponse;
      adapter.fetchResponse=async receipt=>({...await original.call(adapter,receipt),records: source==='mock-cdr'
        ? [{subscriber:'Rahul S.',phone:'9876543210',dob:'1990-01-01',address:'Gandhi Nagar',timestamp:receipt.request.scope.timeFrom}]
        : [{reportedName:'Amit Kumar',reference:'SYNTHETIC-PHASE4-REFERENCE',disposition:'Unverified fictional reference'}]});
      try { r=await intelligenceService.dispatch(kase.id,r.id,inv); } finally {adapter.fetchResponse=original;}
    }
    if(r.status==='RECEIVED') r=await intelligenceService.complete(kase.id,r.id,inv);
    assert.equal(r.status,'COMPLETED');
  }
  const first=await entityResolutionService.integrate(kase.id,inv);
  const candidates=await entityResolutionService.candidates(kase.id,inv);
  assert(candidates.items.some(c=>c.left.entityType==='person' && c.status==='AUTO_RESOLVED'));
  assert(candidates.items.some(c=>c.left.rawValue==='Amit Kumar' && c.right.rawValue==='Amit Kumar' && c.status==='REVIEW_REQUIRED'));
  assert(candidates.items.some(c=>c.left.entityType==='person' && c.status==='DISTINCT'));
  assert(candidates.items.some(c=>c.left.entityType==='vehicle' && c.status==='AUTO_RESOLVED'));
  const counts=async()=>({entities:await prisma.canonicalEntity.count({where:{caseId:kase.id}}),links:await prisma.entitySourceLink.count({where:{caseId:kase.id}}),candidates:await prisma.resolutionCandidate.count({where:{caseId:kase.id}})});
  const before=await counts(); const second=await entityResolutionService.integrate(kase.id,inv);
  assert(second.reused); assert.equal(first.digest,second.digest); assert.deepEqual(await counts(),before);
  console.log(JSON.stringify({synthetic:true,caseId:kase.id,caseReference:kase.caseId,scenarios:{A:'PASS: Rahul + CDR phone/name',B:'PASS: Amit requires review',C:'PASS: phone/DOB/address conflicts distinct',D:'PASS: vehicle formatting',E:'PASS: repeat counts and digest stable'},summary:second,counts:before},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>prisma.$disconnect());
