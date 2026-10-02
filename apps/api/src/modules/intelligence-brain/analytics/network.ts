import { ValidationError } from '../../../core/errors';
import { BRAIN_RULES as R } from '../rules';
import type { CaseGraph, NetworkResult } from '../types';

export function adjacency(graph: CaseGraph) {
  if(graph.nodes.length>R.maxNodes || graph.edges.length>R.maxEdges) throw new ValidationError('Graph exceeds bounded MVP analysis limits');
  const map=new Map(graph.nodes.map(n=>[n.id,new Set<string>()]));
  for(const e of graph.edges) { if(!map.has(e.sourceId)||!map.has(e.targetId)) throw new ValidationError('Dangling graph relationship');
    if(e.sourceId!==e.targetId) {map.get(e.sourceId)!.add(e.targetId);map.get(e.targetId)!.add(e.sourceId);} }
  return map;
}

// Deterministic local modularity optimization on a simple undirected projection.
// Community fallback needs no GDS plugin and does not label communities as gangs.
function communities(adj: Map<string,Set<string>>) {
  const ids=[...adj.keys()].sort(), groups=new Map(ids.map(id=>[id,id]));
  const degrees=new Map(ids.map(id=>[id,adj.get(id)!.size]));
  const total=[...degrees.values()].reduce((a,b)=>a+b,0);
  if(!total) return groups;
  const totals=new Map(degrees);
  for(let pass=0;pass<R.communityPasses;pass++) {
    let moved=false;
    for(const id of ids) {
      const old=groups.get(id)!, degree=degrees.get(id)!;
      totals.set(old,totals.get(old)!-degree);
      const weights=new Map<string,number>();
      for(const neighbor of adj.get(id)!) { const c=groups.get(neighbor)!;weights.set(c,(weights.get(c)??0)+1); }
      const gain=(c:string)=>(weights.get(c)??0)-degree*(totals.get(c)??0)/total;
      let best=old,bestGain=gain(old);
      for(const c of [...weights.keys()].sort()) if(gain(c)>bestGain+1e-12) {best=c;bestGain=gain(c);}
      groups.set(id,best);totals.set(best,(totals.get(best)??0)+degree);
      moved ||= best!==old;
    }
    if(!moved) break;
  }
  // Stable neutral IDs derived from the smallest canonical entity in each group.
  const minima=new Map<string,string>(); for(const id of ids) if(!minima.has(groups.get(id)!)) minima.set(groups.get(id)!,id);
  return new Map(ids.map(id=>[id,`community:${minima.get(groups.get(id)!)}`]));
}

export function analyzeNetwork(graph:CaseGraph):NetworkResult {
  const adj=adjacency(graph),ids=[...adj.keys()].sort(),n=ids.length;
  const between=new Map(ids.map(id=>[id,0]));
  // Brandes unweighted betweenness on the explicitly documented undirected projection.
  for(const source of ids) {
    const stack:string[]=[],queue=[source],pred=new Map(ids.map(id=>[id,[] as string[]]));
    const paths=new Map(ids.map(id=>[id,0])),distance=new Map(ids.map(id=>[id,-1]));paths.set(source,1);distance.set(source,0);
    for(let i=0;i<queue.length;i++) {
      const v=queue[i];stack.push(v);
      for(const w of adj.get(v)!) {
        if(distance.get(w)===-1) {distance.set(w,distance.get(v)!+1);queue.push(w);}
        if(distance.get(w)===distance.get(v)!+1) {paths.set(w,paths.get(w)!+paths.get(v)!);pred.get(w)!.push(v);}
      }
    }
    const delta=new Map(ids.map(id=>[id,0]));
    while(stack.length) { const w=stack.pop()!;
      for(const v of pred.get(w)!) delta.set(v,delta.get(v)!+(paths.get(v)!/paths.get(w)!)*(1+delta.get(w)!));
      if(w!==source) between.set(w,between.get(w)!+delta.get(w)!);
    }
  }
  let ranks=new Map(ids.map(id=>[id,n?1/n:0]));
  for(let iteration=0;iteration<R.pagerankIterations && n;iteration++) {
    const dangling=ids.filter(id=>!adj.get(id)!.size).reduce((sum,id)=>sum+ranks.get(id)!,0);
    const next=new Map(ids.map(id=>[id,(1-R.pagerankDamping)/n+R.pagerankDamping*dangling/n]));
    for(const id of ids) for(const target of adj.get(id)!) next.set(target,next.get(target)!+R.pagerankDamping*ranks.get(id)!/adj.get(id)!.size);
    const difference=ids.reduce((sum,id)=>sum+Math.abs(next.get(id)!-ranks.get(id)!),0);ranks=next;
    if(difference<R.pagerankTolerance) break;
  }
  const membership=communities(adj),communityMap=new Map<string,string[]>();
  for(const id of ids) { const c=membership.get(id)!;communityMap.set(c,[...(communityMap.get(c)??[]),id]); }
  return {algorithm:'simple-undirected degree; Brandes; PageRank; deterministic local modularity',version:R.version,
    metrics:ids.map(id=>({entityId:id,degree:adj.get(id)!.size,degreeCentrality:n>1?adj.get(id)!.size/(n-1):0,
      betweenness:n>2?between.get(id)!/((n-1)*(n-2)):0,pageRank:ranks.get(id)!,communityId:membership.get(id)!})),
    communities:[...communityMap].map(([id,members])=>({id,members,size:members.length}))};
}

export function paths(graph:CaseGraph,source:string,target:string,maxHops:number,limit:number,shortest=false) {
  if(!Number.isInteger(maxHops)||maxHops<1||maxHops>R.maxHops||!Number.isInteger(limit)||limit<1||limit>R.maxResults) throw new ValidationError('Invalid traversal bounds');
  const adj=adjacency(graph); if(!adj.has(source)||!adj.has(target)) throw new ValidationError('Path endpoints must be current case entities');
  const queue:string[][]=[[source]],found:string[][]=[];let cursor=0,visitedPaths=0,truncated=false;
  while(cursor<queue.length && found.length<limit) {
    const path=queue[cursor++],last=path.at(-1)!;
    if(last===target) {found.push(path);if(shortest) break;continue;}
    if(path.length-1>=maxHops) continue;
    for(const neighbor of [...adj.get(last)!].sort()) if(!path.includes(neighbor)) {
      if(++visitedPaths>R.maxEdges) {truncated=true;break;}
      queue.push([...path,neighbor]);
    }
    if(truncated) break;
  }
  return {paths:found.map(ids=>({nodes:ids.map(id=>graph.nodes.find(n=>n.id===id)!),edges:ids.slice(1).flatMap((id,i)=>graph.edges.filter(e=>(e.sourceId===ids[i]&&e.targetId===id)||(e.targetId===ids[i]&&e.sourceId===id)).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,1)),hopCount:ids.length-1})),
    metadata:{projection:'undirected',maxHops,limit,truncated:truncated||(!shortest&&cursor<queue.length)}};
}

export function neighborhood(graph:CaseGraph,entityId:string,hops:number,limit:number) {
  if(!Number.isInteger(hops)||hops<1||hops>R.maxHops||!Number.isInteger(limit)||limit<1||limit>R.maxResults) throw new ValidationError('Invalid neighborhood bounds');
  const adj=adjacency(graph);if(!adj.has(entityId)) throw new ValidationError('Entity is not in current case graph');
  const reached=new Set([entityId]);let frontier=[entityId],truncated=false;
  for(let depth=0;depth<hops;depth++) {const next:string[]=[];
    for(const id of frontier) for(const neighbor of [...adj.get(id)!].sort()) if(!reached.has(neighbor)) {
      if(reached.size>=limit) {truncated=true;continue;} reached.add(neighbor);next.push(neighbor);
    } frontier=next;
  }
  const edges=graph.edges.filter(e=>reached.has(e.sourceId)&&reached.has(e.targetId));
  return {nodes:graph.nodes.filter(n=>reached.has(n.id)),edges:edges.slice(0,R.maxResults),metadata:{hops,limit,truncated:truncated||edges.length>R.maxResults}};
}
