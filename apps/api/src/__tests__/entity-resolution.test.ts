import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, afterAll, describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { MentionType, Permission, ROLE_PERMISSIONS, UserRole } from '@sih/shared';
import { createApp } from '../app';
import { prisma } from '../core/db';
import { eventBus } from '../core/domain-events';
import { auditService } from '../modules/audit/audit.service';
import { sourceAdapters } from '../modules/data-exchange/adapters';
import { entityResolvers, candidatePairs, type MatchRecord } from '../modules/entity-resolution/resolvers';
import { clusterRecords } from '../modules/entity-resolution/clustering';
import { valueNormalizers, normalizeIdentifiers } from '../modules/entity-resolution/normalization';
import { createTestUser, resetDb, TEST_PASSWORD } from './helpers';

const app = createApp();
let token: string, sup: string, outside: string, admin: string, caseId: string, docId: string;
const base = () => `/api/cases/${caseId}/resolution`;
const post = (url: string, body: object = {}, auth = token) => request(app).post(url).set('Authorization',`Bearer ${auth}`).send(body);
const get = (url: string, auth = token) => request(app).get(url).set('Authorization',`Bearer ${auth}`);
async function login(email: string, role: 'investigator'|'supervisor'|'admin'|'auditor') {
  const user = await createTestUser(email,role);
  return { user, token: (await request(app).post('/api/auth/login').send({ email,password: TEST_PASSWORD })).body.token as string };
}
async function upload(text: string, filename = 'identity.txt') {
  const res = await request(app).post(`/api/cases/${caseId}/documents`).set('Authorization',`Bearer ${token}`)
    .attach('file',Buffer.from(text),{ filename,contentType: 'text/plain' });
  expect(res.status).toBe(201);
  expect((await post(`/api/cases/${caseId}/documents/${res.body.id}/process`)).status).toBe(201);
  return res.body.id as string;
}
async function integrate() {
  const res = await post(`${base()}/integrate`); expect(res.status,JSON.stringify(res.body)).toBe(200); return res.body;
}
async function candidates() { return (await get(`${base()}/candidates`)).body.items as Array<{id:string;revision:number;status:string;left:{entityType:string;rawValue:string};right:{rawValue:string}}> }
async function returned(rows: Record<string,unknown>[]) {
  const ib = `/api/cases/${caseId}/intelligence`;
  const analyzed = await post(`${ib}/analyze`);
  const gap = analyzed.body.gaps.find((g: {sourceId:string}) => g.sourceId === 'mock-criminal-history');
  expect(gap).toBeTruthy();
  await post(`${ib}/gaps/${gap.id}/review`,{ decision:'select',note:'Synthetic identities for Phase 4 tests.' });
  const r = await post(`${ib}/requests`,{gapId:gap.id});
  await post(`${ib}/requests/${r.body.id}/submit`);
  expect((await post(`${ib}/requests/${r.body.id}/authorize`,{approved:true,reason:'Independent synthetic approval.'},sup)).status).toBe(200);
  const adapter = sourceAdapters.get('mock-criminal-history')!;
  const original = adapter.fetchResponse.bind(adapter);
  vi.spyOn(adapter,'fetchResponse').mockImplementation(async receipt => ({...await original(receipt),records:rows}));
  expect((await post(`${ib}/requests/${r.body.id}/dispatch`)).status).toBe(200);
  return r.body.id as string;
}
const fir = 'FIR No: FIR-2026/00417\nIncident window: 01 September 2026 to 02 September 2026\nComplainant: Rahul Sharma\nPhone: +91 98765 43210\nAccused: Amit Kumar\nVehicle MP09AB1234 was stolen near Gandhi Nagar Colony.';
const person = (id:string,name:string,ids = {}): MatchRecord => ({ id,entityType:MentionType.PERSON,normalizedValue:name,validIdentifier:false,identifiers:normalizeIdentifiers(ids) });

describe('Phase 4 deterministic resolution rules', () => {
  it.each(['9876543210','+91 98765 43210','0091-9876543210','09876543210'])('normalizes Indian phone %s safely', raw => {
    expect(valueNormalizers.phone(raw)).toEqual({value:'9876543210',validIdentifier:true});
  });
  it('preserves original identifier meaning and rejects fabricated placeholder identifiers', () => {
    expect(valueNormalizers.phone('SYNTHETIC-PHONE-002').validIdentifier).toBe(false);
    expect(valueNormalizers.vehicle('MP 09 AB 1234').value).toBe('MP09AB1234');
    expect(valueNormalizers.money('001234567890').value).toBe('001234567890');
    expect(valueNormalizers.money('Rs. 85,000').validIdentifier).toBe(false);
    expect(normalizeIdentifiers({dob:'2026-02-31'})).toEqual({});
  });
  it('auto resolves compatible names with shared phones but never name alone', () => {
    const a = person('a','rahul sharma',{phone:'9876543210'}), b = person('b','rahul s.',{phone:'+91 98765 43210'});
    expect(entityResolvers.person.compare(a,b).status).toBe('AUTO_RESOLVED');
    expect(entityResolvers.person.compare(person('a','amit kumar'),person('b','amit kumar')).status).toBe('REVIEW_REQUIRED');
  });
  it.each(['phone','dob','governmentId','address'])('blocks conflicting %s even with same name', field => {
    const vals: Record<string,string[]> = {phone:['9876543210','9123456780'],dob:['1990-01-01','1992-01-01'],governmentId:['demo:a','demo:b'],address:['A Nagar','B Nagar']};
    expect(entityResolvers.person.compare(person('a','rahul sharma',{[field]:vals[field][0]}),person('b','rahul sharma',{[field]:vals[field][1]})).status).toBe('DISTINCT');
  });
  it('blocks transitive merges across a DOB conflict', () => {
    const records = [person('a','rahul sharma',{phone:'9876543210',dob:'1990-01-01'}),person('b','rahul s',{phone:'9876543210'}),person('c','rahul sharma',{phone:'9876543210',dob:'1992-01-01'})];
    const links = [{id:'ab',leftId:'a',rightId:'b',status:'AUTO_RESOLVED' as const,score:.94},{id:'bc',leftId:'b',rightId:'c',status:'AUTO_RESOLVED' as const,score:.94}];
    expect(clusterRecords(records,links).groups).toHaveLength(2);
    expect(clusterRecords(records,links).blocked).toHaveLength(1);
  });
  it('blocks by type and identifiers instead of comparing unrelated records', () => {
    const records: MatchRecord[] = Array.from({length:100},(_,i) => ({id:String(i),entityType:MentionType.PHONE,normalizedValue:String(9000000000+i),validIdentifier:true,identifiers:{}}));
    expect(candidatePairs(records)).toHaveLength(0);
  });
  it('uses multiple supporting attributes and government identifiers, and leaves unrelated names unmatched', () => {
    const ids={dob:'1990-01-01',address:'Gandhi Nagar'};
    expect(entityResolvers.person.compare(person('a','rahul sharma',ids),person('b','rahul sharma',ids)).status).toBe('AUTO_RESOLVED');
    expect(entityResolvers.person.compare(person('a','rahul',{governmentId:'demo:123'}),person('b','r sharma',{governmentId:'demo:123'})).status).toBe('AUTO_RESOLVED');
    expect(entityResolvers.person.compare(person('a','amit kumar'),person('b','zoe white')).status).toBe('UNRESOLVED');
  });
  it.each([MentionType.PERSON,MentionType.ORGANIZATION,MentionType.LOCATION] as const)('normalizes %s text without deleting meaningful words', type => {
    expect(valueNormalizers[type]('  Gandhi   Nagar  ').value).toBe('gandhi nagar');
  });
  it('does not equate account identifiers from different banks', () => {
    const a:MatchRecord={id:'a',entityType:MentionType.MONEY,normalizedValue:'001234567890',validIdentifier:true,identifiers:{bank:['bank a']}};
    expect(entityResolvers.money.compare(a,{...a,id:'b',identifiers:{bank:['bank b']}}).status).toBe('DISTINCT');
  });
});

describe('Phase 4 real HTTP + PostgreSQL integration', () => {
  beforeEach(async () => {
    await resetDb();
    token = (await login('inv@p4.test','investigator')).token;
    const supervisor = await login('sup@p4.test','supervisor'); sup = supervisor.token;
    outside = (await login('outside@p4.test','investigator')).token;
    admin = (await login('admin@p4.test','admin')).token;
    caseId = (await post('/api/cases',{title:'Synthetic identity theft'})).body.id;
    await prisma.caseAssignment.create({data:{caseId,userId:supervisor.user.id,role:'supervisor'}});
    docId = await upload(fir);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await resetDb(); await prisma.$disconnect(); });

  it('integrates mentions and authorized packages with full provenance, events and idempotency', async () => {
    await returned([{reportedName:'Rahul S.',phone:'9876543210',reference:'SYNTHETIC-REF'}]);
    const events = vi.spyOn(eventBus,'publish');
    const first = await integrate();
    const matches = await candidates();
    expect(matches.some(c => c.left.entityType === 'person' && c.status === 'AUTO_RESOLVED')).toBe(true);
    const entities = (await get(`${base()}/entities`)).body.items;
    const entity = entities.find((e:{entityType:string;resolutionStatus:string}) => e.entityType === 'person' && e.resolutionStatus === 'AUTO_RESOLVED');
    const detail = (await get(`${base()}/entities/${entity.id}`)).body;
    expect(detail.sources).toHaveLength(2);
    expect(detail.sources.every((s:{record:{evidenceRecord:{provenance:unknown}}}) => s.record.evidenceRecord.provenance)).toBe(true);
    expect(detail.sources.some((s:{record:{sourceLocation:{jsonPointer?:string};department?:string}}) => s.record.sourceLocation.jsonPointer && s.record.department)).toBe(true);
    const state = await prisma.caseIntelligenceState.findUniqueOrThrow({where:{caseId}});
    expect(state.summary).toHaveProperty('documents'); expect(state.summary).toHaveProperty('entityResolution');
    const count = await prisma.resolutionHistory.count();
    const second = await integrate(); expect(second.reused).toBe(true); expect(second.digest).toBe(first.digest);
    expect(await prisma.resolutionHistory.count()).toBe(count);
    expect((await prisma.caseIntelligenceState.findUniqueOrThrow({where:{caseId}})).version).toBe(state.version);
    expect(events.mock.calls.map(([e])=>e.type)).toEqual(expect.arrayContaining(['SourceDataNormalized','EntityResolutionStarted','EntityAutoResolved','EntityResolutionCompleted']));
    expect(await prisma.auditEvent.count({where:{caseId,action:'entity_integrate'}})).toBe(2);
  });
  it('requires review for a name-only match and reverses accept/reject without deleting evidence', async () => {
    await returned([{reportedName:'Amit Kumar',reference:'SYNTHETIC-REF'}]); await integrate();
    const c = (await candidates()).find(c=>c.left.entityType==='person' && c.status==='REVIEW_REQUIRED')!;
    expect(c).toBeTruthy();
    const body = {decision:'accept',reason:'Reviewed original synthetic documents.',expectedRevision:c.revision,idempotencyKey:randomUUID()};
    const accepted = await post(`${base()}/candidates/${c.id}/review`,body); expect(accepted.status,JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.candidate.status).toBe('ACCEPTED');
    expect((await post(`${base()}/candidates/${c.id}/review`,body)).body.reused).toBe(true);
    expect((await post(`${base()}/candidates/${c.id}/review`,{...body,reason:'different'})).status).toBe(400);
    expect((await post(`${base()}/candidates/${c.id}/review`,{...body,idempotencyKey:randomUUID()})).status).toBe(400);
    const n = await prisma.normalizedSourceRecord.count();
    const rejected = await post(`${base()}/candidates/${c.id}/review`,{...body,decision:'reject',reason:'Revised review: identities distinct.',expectedRevision:accepted.body.candidate.revision,idempotencyKey:randomUUID()});
    expect(rejected.body.candidate.status).toBe('REJECTED');
    expect(await prisma.normalizedSourceRecord.count()).toBe(n);
    const detail = (await get(`${base()}/candidates/${c.id}`)).body;
    expect(detail.history.filter((h:{idempotencyKey:string})=>h.idempotencyKey)).toHaveLength(2);
    expect(await prisma.canonicalEntity.count({where:{caseId,active:false}})).toBeGreaterThan(0);
    await integrate(); expect((await get(`${base()}/candidates/${c.id}`)).body.status).toBe('REJECTED');
  });
  it('keeps conflicting same-name identities distinct and forbids manual conflict override', async () => {
    await returned([{reportedName:'Rahul Sharma',phone:'9123456780',dob:'1992-01-01'}]); await integrate();
    const c=(await candidates()).find(c=>c.left.entityType==='person' && c.status==='DISTINCT')!; expect(c).toBeTruthy();
    expect((await post(`${base()}/candidates/${c.id}/review`,{decision:'accept',reason:'Cannot bypass conflict.',expectedRevision:c.revision,idempotencyKey:randomUUID()})).status).toBe(400);
  });
  it('deduplicates formatting variants and keeps force-reprocessed source identities stable', async () => {
    await upload('Vehicle MP 09 AB 1234 was observed.','second.txt');
    await integrate();
    expect((await candidates()).some(c=>c.left.entityType==='vehicle' && c.status==='AUTO_RESOLVED')).toBe(true);
    const keys=(await prisma.normalizedSourceRecord.findMany({where:{caseId},orderBy:{id:'asc'}})).map(r=>r.id);
    expect((await post(`/api/cases/${caseId}/documents/${docId}/process`,{force:true})).status).toBe(201);
    expect((await integrate()).reused).toBe(true);
    expect((await prisma.normalizedSourceRecord.findMany({where:{caseId},orderBy:{id:'asc'}})).map(r=>r.id)).toEqual(keys);
  });
  it('enforces authentication, RBAC, assignment and IDOR for every derived read', async () => {
    await integrate(); const e=(await get(`${base()}/entities`)).body.items[0];
    expect((await request(app).get(`${base()}/entities`)).status).toBe(401);
    for (const view of ['entities','records','candidates','history',`entities/${e.id}`]) {
      expect((await get(`${base()}/${view}`,outside)).status).toBe(404);
      expect((await get(`${base()}/${view}`,admin)).status).toBe(403);
    }
    expect((await post(`${base()}/integrate`,{},outside)).status).toBe(404);
    const second=(await post('/api/cases',{title:'Unrelated'})).body.id;
    expect((await get(`/api/cases/${second}/resolution/entities/${e.id}`)).status).toBe(404);
    expect((await get(`${base()}/candidates/${randomUUID()}`)).status).toBe(404);
  });
  it('fails closed when any returned source permission is missing', async () => {
    await returned([{reportedName:'Rahul S.',phone:'9876543210'}]); await integrate();
    const original=ROLE_PERMISSIONS[UserRole.INVESTIGATOR];
    ROLE_PERMISSIONS[UserRole.INVESTIGATOR]=original.filter(p=>p!==Permission.SOURCE_CRIMINAL_HISTORY);
    try { for (const path of ['entities','records','candidates','history']) expect((await get(`${base()}/${path}`)).status).toBe(403); }
    finally { ROLE_PERMISSIONS[UserRole.INVESTIGATOR]=original; }
  });
  it('rolls back integration if mandatory audit persistence fails', async () => {
    vi.spyOn(auditService,'emit').mockRejectedValueOnce(new Error('synthetic audit failure'));
    expect((await post(`${base()}/integrate`)).status).toBe(500);
    expect(await prisma.normalizedSourceRecord.count()).toBe(0);
    expect(await prisma.resolutionHistory.count()).toBe(0);
  });
  it('serializes concurrent integration without duplicate records or candidates', async () => {
    const responses=await Promise.all([post(`${base()}/integrate`),post(`${base()}/integrate`)]);
    expect(responses.map(r=>r.status)).toEqual([200,200]);
    expect(responses.filter(r=>r.body.reused)).toHaveLength(1);
    const records=await prisma.normalizedSourceRecord.findMany();
    expect(new Set(records.map(r=>r.sourceKey)).size).toBe(records.length);
  });
  it('rejects candidate IDOR, auditor access and invalid review bodies', async () => {
    await returned([{reportedName:'Amit Kumar'}]); await integrate();
    const c=(await candidates()).find(c=>c.status==='REVIEW_REQUIRED')!;
    const second=(await post('/api/cases',{title:'Another assigned case'})).body.id;
    const wrong=`/api/cases/${second}/resolution/candidates/${c.id}`;
    expect((await get(wrong)).status).toBe(404);
    const body={decision:'accept',reason:'Verified.',expectedRevision:c.revision,idempotencyKey:randomUUID()};
    expect((await post(`${wrong}/review`,body)).status).toBe(404);
    const auditor=(await login('auditor@p4.test','auditor')).token;
    expect((await get(`${base()}/entities`,auditor)).status).toBe(403);
    expect((await post(`${base()}/candidates/${c.id}/review`,body,outside)).status).toBe(404);
    expect((await post(`${base()}/candidates/${c.id}/review`,{...body,reason:''})).status).toBe(400);
    expect((await post(`${base()}/candidates/${c.id}/review`,{...body,score:1})).status).toBe(400);
  });
  it('replays failed events without incrementing state twice', async () => {
    const real=eventBus.publish.bind(eventBus); let failed=false;
    const spy=vi.spyOn(eventBus,'publish').mockImplementation(async event=>{
      await real(event);
      if(event.type==='EntityResolutionCompleted' && !failed) {failed=true;throw new Error('Synthetic delivery acknowledgement loss');}
    });
    await integrate(); const state=await prisma.caseIntelligenceState.findUniqueOrThrow({where:{caseId}});
    expect(await prisma.resolutionHistory.count({where:{caseId,publishedAt:null}})).toBeGreaterThan(0);
    spy.mockRestore(); await integrate();
    expect(await prisma.resolutionHistory.count({where:{caseId,publishedAt:null}})).toBe(0);
    expect((await prisma.caseIntelligenceState.findUniqueOrThrow({where:{caseId}})).version).toBe(state.version);
  });
  it('requires reintegration after source changes and retains retired source history', async () => {
    await returned([{reportedName:'Amit Kumar'}]); await integrate();
    const c=(await candidates()).find(c=>c.status==='REVIEW_REQUIRED')!;
    await upload('Witness: Anita Verma','new-context.txt');
    expect((await post(`${base()}/candidates/${c.id}/review`,{decision:'accept',reason:'Old context.',expectedRevision:c.revision,idempotencyKey:randomUUID()})).status).toBe(400);
    await prisma.document.update({where:{id:docId},data:{processingStatus:'failed'}});
    await integrate();
    expect(await prisma.normalizedSourceRecord.count({where:{caseId,documentId:docId,active:false}})).toBeGreaterThan(0);
    expect((await get(`${base()}/candidates/${c.id}`)).body.active).toBe(false);
  });
});
