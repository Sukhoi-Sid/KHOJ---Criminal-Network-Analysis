import assert from 'node:assert/strict';
import { UserRole } from '@sih/shared';
import { prisma } from '../src/core/db';
import { closeGraphDriver,checkGraphConnection } from '../src/core/neo4j';
import { registerCaseIntelligenceStateSubscriber } from '../src/modules/case-platform/intelligence-state.subscriber';
import { brainService } from '../src/modules/intelligence-brain/brain.service';
import { seedMergedDemo } from './merged-demo';

async function main() {
  registerCaseIntelligenceStateSubscriber();assert(await checkGraphConnection(),'Neo4j must be running');
  const investigator=await prisma.user.findUniqueOrThrow({where:{email:'investigator@ncrb.demo'}}),supervisor=await prisma.user.findUniqueOrThrow({where:{email:'supervisor@ncrb.demo'}});
  const inv={id:investigator.id,email:investigator.email,role:UserRole.INVESTIGATOR},sup={id:supervisor.id,email:supervisor.email,role:UserRole.SUPERVISOR};
  const kase=await seedMergedDemo(inv,sup);
  const first=await brainService.run(kase.id,inv);assert.equal(first.status,'COMPLETED');
  const network=await brainService.network(kase.id,inv),signals=await brainService.signals(kase.id,inv,0,200);
  assert(network.metrics.some(m=>m.degree>=4));assert(network.metrics.some(m=>m.betweenness>0));assert(network.communities.length>=2);
  const phones=await prisma.canonicalEntity.findMany({where:{caseId:kase.id,active:true,entityType:'phone'}});
  const a=phones.find(p=>p.displayLabel==='9000000001')!,d=phones.find(p=>p.displayLabel==='9000000004')!;
  const path=await brainService.path(kase.id,inv,a.id,d.id,4,10,true);assert(path.paths[0].hopCount>=2);
  for(const type of ['COMMUNICATION_SPIKE','UNUSUAL_TRANSACTION','RAPID_TRANSACTION_CHAIN','REPEATED_LOCATION_OVERLAP','TEMPORAL_CORRELATION','MULTI_SOURCE_ASSOCIATION'])assert(signals.items.some(s=>s.type===type),`Missing signal ${type}`);
  const count=()=>prisma.analyticalSignal.count({where:{caseId:kase.id}});const before=await count();
  assert.equal((await brainService.run(kase.id,inv)).status,'COMPLETED');assert.equal(await count(),before);
  assert.equal((await brainService.run(kase.id,inv,'rebuild')).status,'COMPLETED');assert((await brainService.status(kase.id,inv)).consistent);
  console.log(JSON.stringify({caseId:kase.id,caseReference:kase.caseId,scenarios:'A–H passed',nodes:network.metrics.length,communities:network.communities.length,signals:before,pathHops:path.paths[0].hopCount,signalTypes:[...new Set(signals.items.map(s=>s.type))]},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await prisma.$disconnect();await closeGraphDriver();});
