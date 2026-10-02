import { randomUUID } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { beforeAll,beforeEach,afterEach,afterAll,describe,it,expect,vi } from 'vitest';
import request from 'supertest';
import { UserRole,Permission,ROLE_PERMISSIONS } from '@sih/shared';
import { prisma } from '../core/db';
import { env } from '../core/env';
import { graphDriver,graphNamespace,closeGraphDriver,checkGraphConnection } from '../core/neo4j';
import { createApp } from '../app';
import { brainService } from '../modules/intelligence-brain/brain.service';
import { graphStore } from '../modules/intelligence-brain/graph-builder/graph-store';
import { eventBus } from '../core/domain-events';
import { auditService } from '../modules/audit/audit.service';
import { entityResolutionService } from '../modules/entity-resolution/resolution.service';
import { seedMergedDemo,DEMO_PHONES } from '../../prisma/merged-demo';
import { createTestUser,resetDb,TEST_PASSWORD } from './helpers';
import type { CaseActor } from '../modules/auth/policies';

const app=createApp();let caseId:string,otherCaseId:string,inv:CaseActor,sup:CaseActor,token:string,outside:string,admin:string,auditor:string;
const base=()=>`/api/cases/${caseId}/brain`;
const get=(path:string,auth=token)=>request(app).get(path).set('Authorization',`Bearer ${auth}`);
const post=(path:string,body:object={},auth=token)=>request(app).post(path).set('Authorization',`Bearer ${auth}`).send(body);
async function login(email:string,role:'investigator'|'supervisor'|'admin'|'auditor') {
  const user=await createTestUser(email,role);const result=await request(app).post('/api/auth/login').send({email,password:TEST_PASSWORD});
  return {actor:{id:user.id,email:user.email,role:role as UserRole},token:result.body.token as string};
}
async function cypher(query:string,params:Record<string,unknown>={}) {
  const session=graphDriver().session({database:env.NEO4J_DATABASE});
  try{return await session.run(query,{caseId,namespace:graphNamespace(),...params});}finally{await session.close();}
}
describe('Merged 5+6 real PostgreSQL + Neo4j + HTTP pipeline',()=>{
  beforeAll(async()=>{
    await resetDb();expect(await checkGraphConnection()).toBe(true);
    const investigator=await login('inv@brain.test','investigator');inv=investigator.actor;token=investigator.token;
    sup=(await login('sup@brain.test','supervisor')).actor;
    outside=(await login('outside@brain.test','investigator')).token;
    admin=(await login('admin@brain.test','admin')).token;auditor=(await login('auditor@brain.test','auditor')).token;
    const kase=await seedMergedDemo(inv,sup,'MERGED-TEST');caseId=kase.id;
    otherCaseId=(await post('/api/cases',{title:'Independent case'})).body.id;
    await entityResolutionService.integrate(otherCaseId,inv);
    const result=await brainService.run(caseId,inv);expect(result.status).toBe('COMPLETED');
  },120000);
  beforeEach(async()=>{expect((await brainService.run(caseId,inv,'sync')).status).toBe('COMPLETED');});
  afterEach(()=>vi.restoreAllMocks());
  afterAll(async()=>{if(caseId)await graphStore.sync(caseId,{nodes:[],edges:[]},true);if(otherCaseId)await graphStore.sync(otherCaseId,{nodes:[],edges:[]},true);await resetDb();await prisma.$disconnect();await closeGraphDriver();});

  it('extracts typed evidence-bound calls, transfers, observations and person associations',async()=>{
    const rows=await prisma.derivedRelationship.findMany({where:{caseId,active:true}});
    expect(rows.map(r=>r.type)).toEqual(expect.arrayContaining(['CALLED','TRANSFERRED_TO','SEEN_AT','ASSOCIATED_WITH_PHONE','ASSOCIATED_WITH_ACCOUNT','OWNS','WORKS_FOR','MENTIONED_IN']));
    for(const row of rows) {expect(row.findingKind).toBe('FACT');expect(row.confidence).toBeGreaterThan(0);expect((row.evidenceRefs as unknown[]).length).toBeGreaterThan(0);expect(row.algorithmVersion).toBe('merged-5-6-v1');}
    const call=rows.find(r=>r.type==='CALLED')!;expect(call.occurredAt).not.toBeNull();expect(call.sourceSystem).toBe('mock-cdr');
    expect(rows.filter(r=>r.type==='ASSOCIATED_WITH_PHONE').every(r=>r.occurredAt===null)).toBe(true);
    expect(rows.some(r=>JSON.stringify(r.evidenceRefs).includes('jsonPointer'))).toBe(true);
  });
  it('synchronizes stable IDs, supports incremental updates and rebuilds without duplicate topology',async()=>{
    const before=await graphStore.snapshot(caseId);
    const run=await post(`${base()}/graph/sync`);expect(run.status,JSON.stringify(run.body)).toBe(200);
    expect(await graphStore.snapshot(caseId)).toEqual(before);
    const rebuild=await post(`${base()}/graph/rebuild`);expect(rebuild.status).toBe(200);
    const after=await graphStore.snapshot(caseId);
    expect(after.nodes.map(n=>n.id).sort()).toEqual(before.nodes.map(n=>n.id).sort());expect(after.edges.map(e=>e.id).sort()).toEqual(before.edges.map(e=>e.id).sort());
    expect((await get(`${base()}/graph/status`)).body.consistent).toBe(true);
  });
  it('detects and repairs missing/extra/duplicate graph entries without trusting graph facts',async()=>{
    const rows=await prisma.derivedRelationship.findMany({where:{caseId,active:true}});const missing=rows[0].id;
    await cypher('MATCH ()-[r:SIH_RELATIONSHIP {caseId:$caseId,namespace:$namespace,id:$id}]->() DELETE r',{id:missing});
    await cypher('CREATE (n:SihEntity {key:$key,caseId:$caseId,namespace:$namespace,id:$id,entityType:"phone"})',{key:randomUUID(),id:'ghost'});
    await cypher('MATCH (a)-[r:SIH_RELATIONSHIP {caseId:$caseId,namespace:$namespace}]->(b) WITH a,r,b LIMIT 1 CREATE (a)-[copy:SIH_RELATIONSHIP]->(b) SET copy=properties(r)');
    const status=(await get(`${base()}/graph/status`)).body;expect(status.consistent).toBe(false);expect(status.issues.missingEdges).toContain(missing);expect(status.issues.extraNodes).toContain('ghost');expect(status.issues.duplicateEdges).toHaveLength(1);
    expect((await get(`${base()}/graph`)).status).toBe(400);
    expect((await post(`${base()}/graph/sync`)).status).toBe(200);expect((await get(`${base()}/graph/status`)).body.consistent).toBe(true);
  });
  it('persists failure status and preserves authoritative records during a real Neo4j outage',async()=>{
    const before=await prisma.derivedRelationship.count({where:{caseId}}),original=env.NEO4J_URI;
    await closeGraphDriver();env.NEO4J_URI='bolt://127.0.0.1:1';
    try {
      const result=await post(`${base()}/graph/sync`);expect(result.status).toBe(503);expect(result.body.error).toBe('GRAPH_SYNC_FAILED');
      expect(await prisma.derivedRelationship.count({where:{caseId}})).toBe(before);
      expect((await prisma.graphSyncState.findUniqueOrThrow({where:{caseId}})).status).toBe('FAILED');
      expect((await get('/health/graph')).status).toBe(503);
      expect((await get(`${base()}/timeline`)).status).toBe(200);
    }finally{await closeGraphDriver();env.NEO4J_URI=original;}
    expect((await post(`${base()}/graph/sync`)).status).toBe(200);
  });
  it('returns network metrics, communities and bounded multi-hop paths with provenance',async()=>{
    const result=await get(`${base()}/network`);expect(result.status).toBe(200);
    expect(result.body.metrics.some((m:{degree:number})=>m.degree>=4)).toBe(true);
    expect(result.body.metrics.some((m:{betweenness:number})=>m.betweenness>0)).toBe(true);
    expect(result.body.metrics.reduce((sum:number,m:{pageRank:number})=>sum+m.pageRank,0)).toBeCloseTo(1,6);
    expect(result.body.communities.length).toBeGreaterThanOrEqual(2);
    const nodes=await prisma.canonicalEntity.findMany({where:{caseId,active:true,entityType:'phone'}});
    const source=nodes.find(n=>n.displayLabel===DEMO_PHONES[1])!.id,target=nodes.find(n=>n.displayLabel===DEMO_PHONES[4])!.id;
    const path=await get(`${base()}/graph/paths?source=${source}&target=${target}&hops=4`);
    expect(path.status).toBe(200);expect(path.body.paths[0].hopCount).toBeGreaterThan(1);expect(path.body.paths[0].edges[0].evidenceRefs[0].evidenceRecordId).toBeTruthy();
    expect((await get(`${base()}/graph/paths?source=${source}&target=${target}&hops=99`)).status).toBe(400);
    expect((await get(`${base()}/graph/neighborhood/${source}?hops=2&limit=10`)).body.nodes.length).toBeLessThanOrEqual(10);
  });
  it('returns chronological source events with entity/type/time filters',async()=>{
    const result=await get(`${base()}/timeline?type=CALLED&from=2026-09-02T10:00:00Z&to=2026-09-02T10:05:00Z`);
    expect(result.status).toBe(200);expect(result.body.total).toBe(6);
    const times=result.body.items.map((e:{occurredAt:string})=>e.occurredAt);expect(times).toEqual([...times].sort());
    expect(result.body.items.every((e:{timeSemantics:string})=>e.timeSemantics==='occurredAt')).toBe(true);
  });
  it('persists explainable communication, financial, location and cross-source signals idempotently',async()=>{
    const before=await prisma.analyticalSignal.count({where:{caseId}});
    expect((await post(`${base()}/patterns/run`)).status).toBe(200);
    const signals=(await get(`${base()}/signals?limit=200`)).body.items;
    expect(signals.map((s:{type:string})=>s.type)).toEqual(expect.arrayContaining(['COMMUNICATION_SPIKE','UNUSUAL_TRANSACTION','RAPID_TRANSACTION_CHAIN','REPEATED_LOCATION_OVERLAP','TEMPORAL_CORRELATION','MULTI_SOURCE_ASSOCIATION']));
    const spike=signals.find((s:{type:string})=>s.type==='COMMUNICATION_SPIKE');expect(spike.reason.metrics.currentCount).toBe(6);expect(spike.reason.metrics.ratio).toBeGreaterThan(3);expect(spike.parameters.spikeRatio).toBe(3);
    const detail=(await get(`${base()}/signals/${spike.id}`)).body;expect(detail.findingKind).toBe('SIGNAL');expect(detail.supports.every((s:{relationship:{caseId:string}})=>s.relationship.caseId===caseId)).toBe(true);
    expect((await post(`${base()}/patterns/run`)).status).toBe(200);expect(await prisma.analyticalSignal.count({where:{caseId}})).toBe(before);
  });
  it('enforces live RBAC, assignment, source permissions, graph/path/signal IDOR and bounded inputs',async()=>{
    const signal=await prisma.analyticalSignal.findFirstOrThrow({where:{caseId}}),node=await prisma.canonicalEntity.findFirstOrThrow({where:{caseId,active:true}});
    expect((await request(app).get(`${base()}/graph`)).status).toBe(401);
    for(const route of ['graph','graph/status','network','timeline','signals',`signals/${signal.id}`,'runs']) {
      expect((await get(`${base()}/${route}`,outside)).status).toBe(404);
      expect((await get(`${base()}/${route}`,admin)).status).toBe(403);
      expect((await get(`${base()}/${route}`,auditor)).status).toBe(403);
    }
    expect((await post(`${base()}/run`,{},outside)).status).toBe(404);expect((await post(`${base()}/run`,{},admin)).status).toBe(403);
    expect((await get(`/api/cases/${otherCaseId}/brain/signals/${signal.id}`)).status).toBe(404);
    await brainService.run(otherCaseId,inv,'sync');
    expect((await get(`/api/cases/${otherCaseId}/brain/graph/paths?source=${node.id}&target=${node.id}`)).status).toBe(404);
    expect((await get(`${base()}/graph?limit=10000`)).status).toBe(400);
    expect((await post(`${base()}/graph/sync`,{cypher:'MATCH (n) DETACH DELETE n'})).status).toBe(400);
    expect((await post(`${base()}/cypher`,{query:'MATCH (n) RETURN n'})).status).toBe(404);
    const permissions=ROLE_PERMISSIONS[UserRole.INVESTIGATOR];ROLE_PERMISSIONS[UserRole.INVESTIGATOR]=permissions.filter(p=>p!==Permission.SOURCE_CDR);
    try{expect((await get(`${base()}/signals`)).status).toBe(403);expect((await post(`${base()}/run`)).status).toBe(403);}finally{ROLE_PERMISSIONS[UserRole.INVESTIGATOR]=permissions;}
  });
  it('rejects corrupted normalized snapshots instead of turning them into graph facts',async()=>{
    const record=await prisma.normalizedSourceRecord.findFirstOrThrow({where:{caseId,sourceKind:'RETURNED_INTELLIGENCE'}});
    await prisma.normalizedSourceRecord.update({where:{id:record.id},data:{attributes:{invented:'relationship'}}});
    try{expect((await post(`${base()}/run`)).status).toBe(400);}finally{await prisma.normalizedSourceRecord.update({where:{id:record.id},data:{attributes:record.attributes!}});}
  });
  it('audits executions and replays interrupted completion delivery without duplicating case state',async()=>{
    // A rebuild has a distinct run type, giving a fresh completion event on the first rebuild in a clean test fixture only.
    const completed=await prisma.brainEvent.findFirstOrThrow({where:{caseId,type:'BrainAnalysisCompleted'},orderBy:{sequence:'desc'}});
    const state=await prisma.caseIntelligenceState.findUniqueOrThrow({where:{caseId}});
    await eventBus.publish({id:completed.id,type:completed.type,timestamp:completed.createdAt.getTime(),payload:{...completed.payload as Record<string,unknown>,caseId,sequence:completed.sequence}});
    expect((await prisma.caseIntelligenceState.findUniqueOrThrow({where:{caseId}})).version).toBe(state.version);
    expect(await prisma.auditEvent.count({where:{caseId,action:'graph_sync'}})).toBeGreaterThan(0);expect(await prisma.auditEvent.count({where:{caseId,action:'brain_analyze'}})).toBeGreaterThan(0);
    expect(state.summary).toHaveProperty('documents');expect(state.summary).toHaveProperty('entityResolution');expect(state.summary).toHaveProperty('brain');
  });
  it('does not commit new derived metadata when mandatory transactional audit fails',async()=>{
    const count=await prisma.derivedRelationship.count({where:{caseId}});
    vi.spyOn(auditService,'emit').mockRejectedValueOnce(new Error('Synthetic audit outage'));
    expect((await post(`${base()}/graph/sync`)).status).toBe(500);expect(await prisma.derivedRelationship.count({where:{caseId}})).toBe(count);
  });
  it('incrementally syncs new canonical entities without fabricating edges from co-mentions',async()=>{
    const unaffected=await graphStore.snapshot(caseId);
    expect((await brainService.run(otherCaseId,inv,'sync')).status).toBe('COMPLETED');
    const before=await graphStore.snapshot(otherCaseId);
    const upload=await request(app).post(`/api/cases/${otherCaseId}/documents`).set('Authorization',`Bearer ${token}`)
      .attach('file',Buffer.from('Unstructured mentions 9876543210 and 9123456780. No supported call record is supplied.'),{filename:'unstructured.txt',contentType:'text/plain'});
    expect(upload.status).toBe(201);
    expect((await post(`/api/cases/${otherCaseId}/documents/${upload.body.id}/process`)).status).toBe(201);
    await entityResolutionService.integrate(otherCaseId,inv);
    expect((await brainService.run(otherCaseId,inv,'sync')).status).toBe('COMPLETED');
    const after=await graphStore.snapshot(otherCaseId);expect(after.nodes.length).toBe(before.nodes.length+2);expect(after.edges).toEqual([]);
    expect(await graphStore.snapshot(caseId)).toEqual(unaffected);
  });
  it('retries durable events after a subscriber acknowledgement fails',async()=>{
    const real=eventBus.publish.bind(eventBus);let interrupted=false;
    const spy=vi.spyOn(eventBus,'publish').mockImplementation(async event=>{await real(event);if(event.type==='GraphSyncCompleted'&&!interrupted){interrupted=true;throw new Error('Synthetic delivery failure');}});
    expect((await post(`${base()}/graph/sync`)).status).toBe(200);
    expect(await prisma.brainEvent.count({where:{caseId,publishedAt:null}})).toBeGreaterThan(0);
    spy.mockRestore();expect((await post(`${base()}/graph/sync`)).status).toBe(200);
    expect(await prisma.brainEvent.count({where:{caseId,publishedAt:null}})).toBe(0);
  });
  it('refuses analysis when original document evidence bytes no longer match their stored hash',async()=>{
    const document=await prisma.document.findFirstOrThrow({where:{caseId,filename:'synthetic-merged-crosslink.txt'}});
    const original=await readFile(document.blobPath);
    try {await writeFile(document.blobPath,Buffer.from('Tampered synthetic test document'));expect((await post(`${base()}/run`)).status).toBe(500);}
    finally {await writeFile(document.blobPath,original);}
  });
});
