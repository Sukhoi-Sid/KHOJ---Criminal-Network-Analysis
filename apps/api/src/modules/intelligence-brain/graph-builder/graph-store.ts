import { env } from '../../../core/env';
import { graphDriver, graphNamespace } from '../../../core/neo4j';
import { hashJson } from '../../../core/json';
import type { CaseGraph } from '../types';
import { int } from 'neo4j-driver';
import { BRAIN_RULES as R } from '../rules';

export interface Topology {nodes:{id:string;entityType:string}[];edges:{id:string;sourceId:string;targetId:string;type:string;sourceCase:string;targetCase:string}[]}
export const topologyDigest=(graph:CaseGraph)=>hashJson({nodes:graph.nodes.map(n=>[n.id,n.entityType]).sort(),edges:graph.edges.map(e=>[e.id,e.sourceId,e.targetId,e.type]).sort()});
export function checkConsistency(graph:CaseGraph,actual:Topology) {
  const expectedNodes=new Map(graph.nodes.map(n=>[n.id,n])),expectedEdges=new Map(graph.edges.map(e=>[e.id,e]));
  const counts=(ids:string[])=>{const map=new Map<string,number>();for(const id of ids)map.set(id,(map.get(id)??0)+1);return map;};
  const nc=counts(actual.nodes.map(n=>n.id)),ec=counts(actual.edges.map(e=>e.id));
  const issues={missingNodes:[...expectedNodes.keys()].filter(id=>!nc.has(id)),extraNodes:[...nc.keys()].filter(id=>!expectedNodes.has(id)),
    missingEdges:[...expectedEdges.keys()].filter(id=>!ec.has(id)),extraEdges:[...ec.keys()].filter(id=>!expectedEdges.has(id)),
    duplicateNodes:[...nc].filter(([,n])=>n>1).map(([id])=>id),duplicateEdges:[...ec].filter(([,n])=>n>1).map(([id])=>id),
    mismatchedNodes:actual.nodes.filter(n=>expectedNodes.has(n.id)&&expectedNodes.get(n.id)!.entityType!==n.entityType).map(n=>n.id),
    mismatchedEdges:actual.edges.filter(e=>{const p=expectedEdges.get(e.id);return p&&(p.sourceId!==e.sourceId||p.targetId!==e.targetId||p.type!==e.type||p.caseId!==e.sourceCase||p.caseId!==e.targetCase);}).map(e=>e.id)};
  return {consistent:Object.values(issues).every(v=>!v.length),issues};
}

export class GraphStore {
  private scope(caseId:string) {return {caseId,namespace:graphNamespace()};}
  async snapshot(caseId:string):Promise<Topology> {
    const session=graphDriver().session({database:env.NEO4J_DATABASE});
    try { return await session.executeRead(async tx=>{
      const nodes=await tx.run('MATCH (n:SihEntity {caseId:$caseId, namespace:$namespace}) RETURN n.id AS id, n.entityType AS entityType LIMIT $limit',{...this.scope(caseId),limit:int(R.maxNodes+1)});
      const edges=await tx.run('MATCH (a)-[r:SIH_RELATIONSHIP {caseId:$caseId, namespace:$namespace}]->(b) RETURN r.id AS id, a.id AS sourceId, b.id AS targetId, r.type AS type, a.caseId AS sourceCase, b.caseId AS targetCase LIMIT $limit',{...this.scope(caseId),limit:int(R.maxEdges+1)});
      return {nodes:nodes.records.map(r=>r.toObject() as Topology['nodes'][number]),edges:edges.records.map(r=>r.toObject() as Topology['edges'][number])};
    },{timeout:10000});} finally {await session.close();}
  }
  async sync(caseId:string,graph:CaseGraph,rebuild=false) {
    const namespace=graphNamespace(),key=(id:string)=>`${namespace}:${caseId}:${id}`;
    const session=graphDriver().session({database:env.NEO4J_DATABASE});
    try {
      await session.run('CREATE CONSTRAINT sih_entity_key IF NOT EXISTS FOR (n:SihEntity) REQUIRE n.key IS UNIQUE');
      await session.executeWrite(async tx=>{
        const scope=this.scope(caseId);
        if(rebuild) await tx.run('MATCH (n:SihEntity {caseId:$caseId, namespace:$namespace}) DETACH DELETE n',scope);
        const nodes=graph.nodes.map(n=>({id:n.id,key:key(n.id),entityType:n.entityType}));
        const edges=graph.edges.map(e=>({id:e.id,key:key(e.id),sourceKey:key(e.sourceId),targetKey:key(e.targetId),type:e.type,confidence:e.confidence,evidenceIds:[...new Set(e.evidenceRefs.map(r=>r.evidenceRecordId))]}));
        await tx.run('MATCH ()-[r:SIH_RELATIONSHIP {caseId:$caseId, namespace:$namespace}]->() WHERE NOT r.key IN $keys DELETE r',{...scope,keys:edges.map(e=>e.key)});
        await tx.run('MATCH (n:SihEntity {caseId:$caseId, namespace:$namespace}) WHERE NOT n.key IN $keys DETACH DELETE n',{...scope,keys:nodes.map(n=>n.key)});
        await tx.run('UNWIND $nodes AS row MERGE (n:SihEntity {key:row.key}) SET n.id=row.id, n.caseId=$caseId, n.namespace=$namespace, n.entityType=row.entityType',{...scope,nodes});
        await tx.run('UNWIND $edges AS row MATCH (a)-[r:SIH_RELATIONSHIP {key:row.key,caseId:$caseId,namespace:$namespace}]->(b) WHERE a.key <> row.sourceKey OR b.key <> row.targetKey DELETE r',{...scope,edges});
        // Fixed relationship label; taxonomy is a parameterized property. No raw or user-assembled Cypher.
        await tx.run('UNWIND $edges AS row MATCH (a:SihEntity {key:row.sourceKey,caseId:$caseId,namespace:$namespace}), (b:SihEntity {key:row.targetKey,caseId:$caseId,namespace:$namespace}) MERGE (a)-[r:SIH_RELATIONSHIP {key:row.key}]->(b) SET r.id=row.id, r.caseId=$caseId, r.namespace=$namespace, r.type=row.type, r.confidence=row.confidence, r.evidenceIds=row.evidenceIds',{...scope,edges});
        await tx.run('MATCH ()-[r:SIH_RELATIONSHIP {caseId:$caseId,namespace:$namespace}]->() WITH r.key AS key, collect(r) AS rs FOREACH (r IN tail(rs) | DELETE r)',scope);
      },{timeout:20000});
    } finally {await session.close();}
    return checkConsistency(graph,await this.snapshot(caseId));
  }
}
export const graphStore=new GraphStore();
