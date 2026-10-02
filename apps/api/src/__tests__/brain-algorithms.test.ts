import { describe,it,expect } from 'vitest';
import { MentionType, type CaseGraph, type GraphEdge } from '@sih/shared';
import { analyzeNetwork,paths,neighborhood } from '../modules/intelligence-brain/analytics/network';
import { analyzePatterns } from '../modules/intelligence-brain/analytics/patterns';
import { timeline,activity } from '../modules/intelligence-brain/analytics/temporal';
import { sourceTime } from '../modules/intelligence-brain/graph-builder/relationships';
import { checkConsistency } from '../modules/intelligence-brain/graph-builder/graph-store';

const edge=(id:string,sourceId:string,targetId:string,type:GraphEdge['type']='CALLED',time:string|null='2026-09-01T10:00:00Z',attributes:Record<string,unknown>={}):GraphEdge=>({
  id,caseId:'case',sourceId,targetId,type,direction:'DIRECTED',confidence:.9,strength:1,findingKind:'FACT',occurredAt:time,observedAt:null,endAt:null,
  sourceSystem:type==='TRANSFERRED_TO'?'finance':type==='SEEN_AT'?'surveillance':'telecom',sourceRecordIds:[id],
  evidenceRefs:[{evidenceRecordId:`evidence-${id}`,documentId:'doc',sourceRecordId:id,sourceLocation:{jsonPointer:`/records/${id}`},contentHash:'hash'}],attributes,
});
const graph=(edges:GraphEdge[],extra:string[]=[]):CaseGraph=>({nodes:[...new Set([...edges.flatMap(e=>[e.sourceId,e.targetId]),...extra])].map(id=>({id,caseId:'case',entityType:MentionType.PHONE,label:id})),edges});
const patterns=(g:CaseGraph)=>analyzePatterns(g,analyzeNetwork(g));

describe('Merged 5+6 deterministic graph algorithms',()=>{
  it('computes independent degree, normalized Brandes betweenness and PageRank metrics',()=>{
    const result=analyzeNetwork(graph([edge('ab','a','b'),edge('bc','b','c')]));
    const center=result.metrics.find(m=>m.entityId==='b')!;
    expect(center.degree).toBe(2);expect(center.degreeCentrality).toBe(1);expect(center.betweenness).toBe(1);
    expect(center.pageRank).toBeGreaterThan(result.metrics.find(m=>m.entityId==='a')!.pageRank);
    expect(result.metrics.reduce((n,m)=>n+m.pageRank,0)).toBeCloseTo(1,8);
    expect(center).not.toHaveProperty('criminalScore');
  });
  it('detects two densely connected communities joined by one bridge',()=>{
    const edges:GraphEdge[]=[];for(const group of [['a','b','c','d'],['e','f','g','h']])for(let i=0;i<group.length;i++)for(let j=i+1;j<group.length;j++)edges.push(edge(`${group[i]}${group[j]}`,group[i],group[j]));
    edges.push(edge('de','d','e'));
    const result=analyzeNetwork(graph(edges));expect(result.communities.map(c=>c.size).sort()).toEqual([4,4]);
    expect(result.metrics.find(m=>m.entityId==='d')!.betweenness).toBeGreaterThan(result.metrics.find(m=>m.entityId==='a')!.betweenness);
  });
  it('handles empty, isolated, disconnected and duplicate-event topology',()=>{
    expect(analyzeNetwork(graph([])).metrics).toEqual([]);
    expect(analyzeNetwork(graph([],['alone'])).metrics[0]).toMatchObject({degree:0,betweenness:0,pageRank:1});
    const g=graph([edge('ab','a','b'),edge('ab2','a','b')],['c']);expect(analyzeNetwork(g).metrics.find(m=>m.entityId==='a')!.degree).toBe(1);
    expect(paths(g,'a','c',4,10,true).paths).toEqual([]);
  });
  it('returns evidence-bearing paths and honors hops, direction projection and result bounds',()=>{
    const g=graph([edge('ab','a','b'),edge('bc','b','c'),edge('cd','c','d')]);
    expect(paths(g,'a','d',2,10,true).paths).toEqual([]);
    const path=paths(g,'a','d',3,10,true).paths[0];expect(path.hopCount).toBe(3);expect(path.edges.map(e=>e.id)).toEqual(['ab','bc','cd']);
    expect(path.edges.every(e=>e.evidenceRefs.length)).toBe(true);
    expect(neighborhood(g,'a',1,10).nodes.map(n=>n.id)).toEqual(['a','b']);
    expect(neighborhood(g,'a',2,10).nodes.map(n=>n.id)).toEqual(['a','b','c']);
    expect(()=>paths(g,'a','d',5,10)).toThrow(/bounds/);expect(()=>neighborhood(g,'a',2,201)).toThrow(/bounds/);
  });
  it('detects missing, extra, duplicate and mismatched graph state',()=>{
    const g=graph([edge('ab','a','b')]);const check=checkConsistency(g,{nodes:[{id:'a',entityType:'phone'},{id:'a',entityType:'phone'},{id:'ghost',entityType:'phone'}],edges:[{id:'ghost-edge',sourceId:'a',targetId:'ghost',type:'CALLED',sourceCase:'case',targetCase:'other'}]});
    expect(check.consistent).toBe(false);expect(check.issues.missingNodes).toEqual(['b']);expect(check.issues.duplicateNodes).toEqual(['a']);expect(check.issues.extraEdges).toEqual(['ghost-edge']);expect(check.issues.missingEdges).toEqual(['ab']);
  });
});
describe('Merged 5+6 temporal semantics and patterns',()=>{
  it('requires explicit timezone and normalizes source times to UTC',()=>{
    expect(sourceTime('2026-09-01T15:30:00+05:30')?.toISOString()).toBe('2026-09-01T10:00:00.000Z');
    expect(sourceTime('2026-09-01 15:30')).toBeNull();expect(sourceTime(undefined)).toBeNull();
  });
  it('orders events, filters entity/type/window and preserves unknown timestamps',()=>{
    const events=[edge('later','a','b','CALLED','2026-09-01T11:00:00Z'),edge('unknown','a','c','CALLED',null),edge('early','b','c')];
    expect(timeline(events).items.map(e=>e.id)).toEqual(['early','later','unknown']);
    expect(timeline(events,{entityId:'a',from:'2026-09-01T10:30:00Z',type:'CALLED'}).items.map(e=>e.id)).toEqual(['later']);
    expect(activity(events).missingTimestamps).toBe(1);
    expect(()=>timeline(events,{from:'2026-09-02T00:00:00Z',to:'2026-09-01T00:00:00Z'})).toThrow();
  });
  it('detects a low-baseline communication spike with exact reason and provenance',()=>{
    const events=[edge('base','a','b','CALLED','2026-09-01T00:00:00Z'),...Array.from({length:4},(_,i)=>edge(`spike${i}`,'a','b','CALLED',`2026-09-01T04:0${i}:00Z`))];
    const s=patterns(graph(events)).signals.find(s=>s.type==='COMMUNICATION_SPIKE')!;
    expect(s.reason.metrics).toMatchObject({currentCount:4,baselinePerHour:.25,ratio:16});expect(s.relationshipIds).toContain('base');
    expect(s.evidenceRefs).toHaveLength(5);expect(s.findingKind).toBe('SIGNAL');expect(s.reason.caution).toContain('Not evidence of guilt');
  });
  it('does not invent a spike from missing baseline or timestamps',()=>{
    const g=graph([edge('one','a','b'),edge('two','a','b'),edge('three','a','b'),edge('unknown','a','b','CALLED',null)]);
    expect(patterns(g).signals.some(s=>s.type==='COMMUNICATION_SPIKE')).toBe(false);
  });
  it('detects financial outliers within currency and time-ordered rapid/circular transfers',()=>{
    const events=[0,1,2,3].map(i=>edge(`base${i}`,'a','b','TRANSFERRED_TO',`2026-09-01T0${i}:00:00Z`,{amount:100,currency:'INR'}));
    events.push(edge('large','a','b','TRANSFERRED_TO','2026-09-01T10:00:00Z',{amount:10000,currency:'INR'}),edge('bc','b','c','TRANSFERRED_TO','2026-09-01T10:03:00Z',{amount:100,currency:'INR'}),edge('ca','c','a','TRANSFERRED_TO','2026-09-01T10:06:00Z',{amount:100,currency:'INR'}));
    const signals=patterns(graph(events)).signals;
    expect(signals.find(s=>s.type==='UNUSUAL_TRANSACTION')!.reason.metrics).toMatchObject({flaggedRelationshipId:'large',upperFence:100});
    expect(signals.some(s=>s.type==='RAPID_TRANSACTION_CHAIN'&&s.relationshipIds.includes('bc'))).toBe(true);
    expect(signals.find(s=>s.type==='CIRCULAR_FINANCIAL_FLOW')!.relationshipIds).toEqual(['bc','ca','large']);
  });
  it('detects repeated location overlap across independent observation windows',()=>{
    const events=[edge('a1','a','loc','SEEN_AT'),edge('b1','b','loc','SEEN_AT'),edge('a2','a','loc','SEEN_AT','2026-09-01T11:00:00Z'),edge('b2','b','loc','SEEN_AT','2026-09-01T11:00:00Z')];
    expect(patterns(graph(events)).signals.find(s=>s.type==='REPEATED_LOCATION_OVERLAP')!.reason.metrics.distinctWindows).toBe(2);
    expect(patterns(graph(events.slice(0,2))).signals.some(s=>s.type==='REPEATED_LOCATION_OVERLAP')).toBe(false);
  });
  it('correlates three sources only with an evidenced shared entity and never asserts causation',()=>{
    const events=[edge('call','phone','other'),edge('payment','acct','payee','TRANSFERRED_TO','2026-09-01T10:02:00Z',{amount:100,currency:'INR'}),edge('seen','person','loc','SEEN_AT','2026-09-01T10:03:00Z'),edge('phone-owner','person','phone','ASSOCIATED_WITH_PHONE',null),edge('acct-owner','person','acct','ASSOCIATED_WITH_ACCOUNT',null)];
    const s=patterns(graph(events)).signals.find(s=>s.type==='MULTI_SOURCE_ASSOCIATION')!;
    expect(s.relationshipIds).toEqual(expect.arrayContaining(['call','payment','seen','phone-owner','acct-owner']));expect(s.reason.metrics.categories).toHaveLength(3);
    expect(patterns(graph(events.slice(0,3))).signals.some(s=>s.type==='TEMPORAL_CORRELATION')).toBe(false);
  });
  it('keeps empty cases signal-free and enforces the burst boundary',()=>{
    expect(patterns(graph([])).signals).toEqual([]);
    const events=[edge('1','a','b'),edge('2','a','b')];
    expect(patterns(graph(events)).signals.some(s=>s.type==='REPEATED_COMMUNICATION')).toBe(false);
    expect(patterns(graph([...events,edge('3','a','b')])).signals.some(s=>s.type==='REPEATED_COMMUNICATION')).toBe(true);
  });
});
