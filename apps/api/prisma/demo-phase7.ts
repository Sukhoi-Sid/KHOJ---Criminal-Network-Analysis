import assert from 'node:assert/strict';
import {UserRole} from '@sih/shared';
import {prisma} from '../src/core/db';
import {closeGraphDriver,checkGraphConnection} from '../src/core/neo4j';
import {brainService} from '../src/modules/intelligence-brain/brain.service';
import {investigativeRagService} from '../src/modules/investigative-rag/rag.service';
import {seedMergedDemo,DEMO_PHONES} from './merged-demo';

async function main(){
  assert(await checkGraphConnection(),'Neo4j must be running');
  const investigator=await prisma.user.findUniqueOrThrow({where:{email:'investigator@ncrb.demo'}}),supervisor=await prisma.user.findUniqueOrThrow({where:{email:'supervisor@ncrb.demo'}});
  const inv={id:investigator.id,email:investigator.email,role:UserRole.INVESTIGATOR},sup={id:supervisor.id,email:supervisor.email,role:UserRole.SUPERVISOR};
  const kase=await seedMergedDemo(inv,sup);assert.equal((await brainService.run(kase.id,inv)).status,'COMPLETED');
  const phones=await prisma.canonicalEntity.findMany({where:{caseId:kase.id,active:true,entityType:'phone'}});
  const phone=(label:string)=>phones.find(p=>p.displayLabel.replace(/\D/g,'').endsWith(label))!.id;
  const scenarios={
    A:await investigativeRagService.ask(kase.id,inv,{question:'How are these entities connected?',entityIds:[phone(DEMO_PHONES[1]),phone(DEMO_PHONES[4])]}),
    B:await investigativeRagService.ask(kase.id,inv,{question:'Why is this entity important in the network?',entityIds:[phone(DEMO_PHONES[0])]}),
    C:await investigativeRagService.ask(kase.id,inv,{question:'What happened around the incident time?',from:'2026-09-02T10:00:00Z',to:'2026-09-02T10:15:00Z'}),
    D:await investigativeRagService.ask(kase.id,inv,{question:'Were there unusual communications?'}),
    E:await investigativeRagService.ask(kase.id,inv,{question:'What evidence supports this relationship?',entityIds:[phone(DEMO_PHONES[0]),phone(DEMO_PHONES[1])]}),
    F:await investigativeRagService.ask(kase.id,inv,{question:'Did this person commit the crime?',entityIds:[phone(DEMO_PHONES[0])]})
  };
  assert(scenarios.A.inferences.some(c=>/hop/.test(c.statement))&&scenarios.A.citations.some(c=>c.kind==='EVIDENCE'));
  assert(scenarios.B.inferences.some(c=>/betweenness/.test(c.statement)&&/not guilt/.test(c.statement)));
  assert(scenarios.C.facts.length&&scenarios.D.signals.length&&scenarios.E.citations.some(c=>c.evidenceRecordId));
  assert(scenarios.F.limitations.some(l=>/cannot determine guilt/i.test(l))&&!/\bis guilty\b/i.test(scenarios.F.answer));
  const isolated=await prisma.case.upsert({where:{caseId:'REF-2026-RAG-ISOLATION'},update:{},create:{caseId:'REF-2026-RAG-ISOLATION',title:'Synthetic isolated case',classification:'confidential',createdById:supervisor.id,assignments:{create:{userId:supervisor.id,role:'supervisor'}},intelligenceState:{create:{summary:{}}}}});
  let denied=false;try{await investigativeRagService.ask(isolated.id,inv,{question:'Show evidence from this case'});}catch{denied=true;}assert(denied);
  console.log(JSON.stringify({caseReference:kase.caseId,scenarios:'A–G passed',connectionHops:scenarios.A.inferences[0].statement,keyEntityExplained:true,timelineClaims:scenarios.C.facts.length,communicationSignals:scenarios.D.signals.length,evidenceCitations:scenarios.E.citations.filter(c=>c.kind==='EVIDENCE').length,guiltRefused:true,crossCaseDenied:true,provider:scenarios.A.answerQuality.provider,model:scenarios.A.answerQuality.model},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await prisma.$disconnect();await closeGraphDriver();});
