import { BRAIN_RULES as R } from '../rules';
import { eventTime, activity } from './temporal';
import type { CaseGraph, GraphEdge, NetworkResult, SignalInput } from '../types';
import { hashJson } from '../../../core/json';
import { ValidationError } from '../../../core/errors';

export interface IncidentWindow {from:string;to:string}
const timed=(edges:GraphEdge[])=>edges.filter(e=>eventTime(e)).sort((a,b)=>eventTime(a)!.localeCompare(eventTime(b)!)||a.id.localeCompare(b.id));
const ms=(e:GraphEdge)=>Date.parse(eventTime(e)!);
const groupBy=<T>(items:T[],key:(item:T)=>string)=>{const groups=new Map<string,T[]>();for(const item of items){const k=key(item);groups.set(k,[...(groups.get(k)??[]),item]);}return groups;};
const quantile=(sorted:number[],p:number)=>{const pos=(sorted.length-1)*p,lo=Math.floor(pos);return sorted[lo]+(sorted[Math.ceil(pos)]-sorted[lo])*(pos-lo);};

export function analyzePatterns(graph:CaseGraph,network:NetworkResult,incidentWindows:IncidentWindow[]=[]) {
  const signals=new Map<string,SignalInput>(),edges=graph.edges;
  const emit=(type:string,support:GraphEdge[],metrics:Record<string,unknown>,description:string,strength=.7)=>{
    if(!support.length)return;
    support=[...new Map(support.map(e=>[e.id,e])).values()].sort((a,b)=>a.id.localeCompare(b.id));
    const times=support.map(eventTime).filter((t):t is string=>!!t).sort();
    const signal:SignalInput={type,entityIds:[...new Set(support.flatMap(e=>[e.sourceId,e.targetId]))].sort(),relationshipIds:support.map(e=>e.id),
      evidenceRefs:[...new Map(support.flatMap(e=>e.evidenceRefs).map(r=>[hashJson(r),r])).values()],strength,confidence:Math.min(...support.map(e=>e.confidence)),
      timeFrom:times[0]??null,timeTo:times.at(-1)??null,findingKind:'SIGNAL',rule:type,version:R.version,parameters:{...R},
      reason:{description,metrics,caution:'Derived investigative signal. Not evidence of guilt, illegality, or causation.'}};
    signals.set(hashJson([type,signal.relationshipIds,metrics]),signal);
    if(signals.size>R.maxEdges)throw new ValidationError('Signal result limit exceeded');
  };
  const inIncident=(e:GraphEdge)=>eventTime(e)!==null&&incidentWindows.some(w=>ms(e)>=Date.parse(w.from)&&ms(e)<=Date.parse(w.to));
  const calls=timed(edges.filter(e=>e.type==='CALLED'||e.type==='COMMUNICATED_WITH'));
  const transfers=timed(edges.filter(e=>e.type==='TRANSFERRED_TO'));
  const locations=timed(edges.filter(e=>e.type==='SEEN_AT'||e.type==='VISITED'));
  const metricMap=new Map(network.metrics.map(m=>[m.entityId,m]));
  const communication=[];
  for(const [source,items] of groupBy(calls,e=>e.sourceId)) {
    const targets=groupBy(items,e=>e.targetId),buckets=groupBy(items,e=>String(Math.floor(ms(e)/R.windowMs)));
    const firstBucket=Math.floor(ms(items[0])/R.windowMs);
    const firstConnections=[...targets].map(([target,events])=>({target,firstObservedAt:eventTime(events[0]),count:events.length}));
    for(const [bucket,events] of buckets) {
      const priorHours=Number(bucket)-firstBucket,prior=items.filter(e=>Math.floor(ms(e)/R.windowMs)<Number(bucket));
      const baseline=priorHours>0?prior.length/priorHours:0;
      if(priorHours>=2&&prior.length>0&&events.length>=R.minimumBurst&&events.length>=baseline*R.spikeRatio)
        emit('COMMUNICATION_SPIKE',[...prior,...events],{source,currentCount:events.length,baselinePerHour:baseline,ratio:events.length/baseline,priorHours},'Communication volume exceeds the earlier observed hourly baseline.');
      const newTargets=events.filter(e=>targets.get(e.targetId)![0].id===e.id);
      if(newTargets.length>=R.minimumBurst) emit('NEW_CONNECTION_BURST',newTargets,{source,newTargets:newTargets.length,windowMs:R.windowMs},'Several first-observed contacts occur in one window; new means new within this case dataset.');
    }
    for(const [target,events] of targets) {
      for(let i=0;i<events.length;i++) {
        const near=events.slice(i).filter(e=>ms(e)-ms(events[i])<=R.shortCommunicationMs);
        if(near.length>=R.minimumBurst) {emit('REPEATED_COMMUNICATION',near,{source,target,count:near.length,windowMs:R.shortCommunicationMs},'Repeated communication in a short source-timestamp window.');break;}
      }
      const reverse=calls.filter(e=>e.sourceId===target&&e.targetId===source);
      if(reverse.length&&source<target) emit('RECIPROCAL_COMMUNICATION',[...events,...reverse],{forward:events.length,reverse:reverse.length},'Both communication directions are observed.');
    }
    const incident=items.filter(inIncident);
    if(incident.length>=R.minimumBurst) emit('INCIDENT_COMMUNICATION_CONCENTRATION',incident,{source,incidentCount:incident.length,totalCount:items.length,fraction:incident.length/items.length,incidentWindows},'Communication occurs within the explicitly recorded incident window; concentration is descriptive.');
    communication.push({entityId:source,total:items.length,uniqueTargets:targets.size,firstConnections,incidentCount:incident.length});
  }
  for(const e of calls) if(metricMap.get(e.sourceId)?.communityId!==metricMap.get(e.targetId)?.communityId)
    emit('CROSS_COMMUNITY_COMMUNICATION',[e],{sourceCommunity:metricMap.get(e.sourceId)?.communityId,targetCommunity:metricMap.get(e.targetId)?.communityId},'Observed communication crosses computed network communities.');

  const amounts=transfers.filter(e=>typeof e.attributes.amount==='number'&&Number.isFinite(e.attributes.amount));
  for(const [currency,items] of groupBy(amounts,e=>String(e.attributes.currency))) {
    if(items.length<R.minimumFinancialBaseline)continue;
    const values=items.map(e=>Number(e.attributes.amount)).sort((a,b)=>a-b),q1=quantile(values,.25),q3=quantile(values,.75),upper=q3+R.iqrMultiplier*(q3-q1);
    for(const e of items) if(Number(e.attributes.amount)>upper) emit('UNUSUAL_TRANSACTION',items,{flaggedRelationshipId:e.id,amount:e.attributes.amount,currency,q1,q3,upperFence:upper,sampleSize:items.length},'Transaction exceeds the case-local IQR upper fence for the same currency.');
  }
  for(const [,items] of groupBy(transfers,e=>e.sourceId)) {
    for(const [,events] of groupBy(items,e=>String(Math.floor(ms(e)/R.windowMs)))) if(events.length>=R.minimumBurst)
      emit('TRANSACTION_BURST',events,{count:events.length,windowMs:R.windowMs},'Several transactions are observed within one window.');
    for(const [,events] of groupBy(items,e=>e.targetId)) if(events.length>=R.minimumBurst)
      emit('REPEATED_TRANSFERS',events,{count:events.length},'Repeated transfers between the same directed account pair.');
  }
  for(const direction of ['sourceId','targetId'] as const) for(const [,items] of groupBy(transfers,e=>e[direction])) {
    const other=direction==='sourceId'?'targetId':'sourceId';
    if(new Set(items.map(e=>e[other])).size>=R.fanThreshold) emit(direction==='sourceId'?'FINANCIAL_FAN_OUT':'FINANCIAL_FAN_IN',items,
      {counterparties:new Set(items.map(e=>e[other])).size,threshold:R.fanThreshold},'Transfers connect an account to multiple counterparties in the observed case dataset.');
  }
  const outgoing=groupBy(transfers,e=>e.sourceId);let examined=0;
  const extend=(chain:GraphEdge[])=>{
    if(++examined>R.maxEdges*10)throw new ValidationError('Financial path comparison limit exceeded');
    const last=chain.at(-1)!;
    if(chain.length>=2) emit('RAPID_TRANSACTION_CHAIN',chain,{hops:chain.length,elapsedMs:ms(last)-ms(chain[0])},'Time-ordered transfers share successive account endpoints; this does not establish that the same funds moved.');
    if(chain.length>=3&&last.targetId===chain[0].sourceId) {emit('CIRCULAR_FINANCIAL_FLOW',chain,{hops:chain.length},'A time-ordered observed transfer path returns to its initial account.');return;}
    if(chain.length>=R.maxHops) return;
    for(const next of outgoing.get(last.targetId)??[]) if(ms(next)>ms(last)&&ms(next)-ms(chain[0])<=R.proximityMs&&!chain.some(e=>e.id===next.id)) extend([...chain,next]);
  };
  for(const transfer of transfers) extend([transfer]);
  const incidentTransfers=transfers.filter(inIncident);
  if(incidentTransfers.length)emit('INCIDENT_WINDOW_TRANSACTIONS',incidentTransfers,{count:incidentTransfers.length,incidentWindows},'Transfers are timestamped within the recorded incident window.');

  const overlaps=new Map<string,GraphEdge[]>();
  for(const [,items] of groupBy(locations,e=>`${e.targetId}:${Math.floor(ms(e)/R.windowMs)}`)) {
    const subjects=[...new Set(items.map(e=>e.sourceId))].sort();
    if(subjects.length>=2)emit('MULTIPLE_ENTITIES_AT_LOCATION',items,{entities:subjects.length,windowMs:R.windowMs},'Independent observations place multiple entities at the same normalized location within a time bucket.');
    for(let i=0;i<subjects.length;i++)for(let j=i+1;j<subjects.length;j++) {
      const key=`${subjects[i]}:${subjects[j]}:${items[0].targetId}`;
      overlaps.set(key,[...(overlaps.get(key)??[]),...items.filter(e=>[subjects[i],subjects[j]].includes(e.sourceId))]);
    }
  }
  for(const items of overlaps.values()) {const windows=new Set(items.map(e=>Math.floor(ms(e)/R.windowMs)));
    if(windows.size>=R.minimumLocationOverlap)emit('REPEATED_LOCATION_OVERLAP',items,{distinctWindows:windows.size},'The same entity pair has repeated independently sourced location overlap.');}
  const locationChains=[];
  for(const [entityId,items] of groupBy(locations,e=>e.sourceId)) {
    locationChains.push({entityId,sequence:items.map(e=>({locationId:e.targetId,time:eventTime(e),relationshipId:e.id}))});
    const sites=groupBy(items,e=>e.targetId),dominant=[...sites.values()].sort((a,b)=>b.length-a.length)[0];
    if(dominant.length>=R.minimumBurst)for(const visit of items)if(visit.targetId!==dominant[0].targetId)
      emit('UNEXPECTED_LOCATION_ASSOCIATION',[...dominant,visit],{usualLocation:dominant[0].targetId,usualCount:dominant.length,newLocation:visit.targetId},'A less frequent location differs from the case-local repeated observation baseline; no external normality is assumed.');
  }
  const incidentLocations=locations.filter(inIncident);if(incidentLocations.length)emit('INCIDENT_LOCATION_OVERLAP',incidentLocations,{count:incidentLocations.length,incidentWindows},'Location observations overlap the documented incident period.');

  // Cross-source correlation only through a common endpoint or explicit identity association, never arbitrary co-occurrence.
  const associations=edges.filter(e=>['ASSOCIATED_WITH_PHONE','ASSOCIATED_WITH_ACCOUNT','ASSOCIATED_WITH_VEHICLE','OWNS'].includes(e.type));
  const anchored=new Map<string,GraphEdge[]>();
  for(const e of [...calls,...transfers,...locations]) for(const endpoint of [e.sourceId,e.targetId]) {
    const anchors=[endpoint,...associations.filter(a=>a.targetId===endpoint).map(a=>a.sourceId)];
    for(const anchor of anchors) anchored.set(anchor,[...(anchored.get(anchor)??[]),e]);
  }
  for(const [anchor,items] of anchored) {
    const ordered=timed([...new Map(items.map(e=>[e.id,e])).values()]);
    for(let i=0;i<ordered.length;i++) {
      const near=ordered.slice(i).filter(e=>ms(e)-ms(ordered[i])<=R.proximityMs);
      const categories=new Set(near.map(e=>e.type==='TRANSFERRED_TO'?'financial':e.type==='CALLED'||e.type==='COMMUNICATED_WITH'?'communication':'location'));
      const sourceSystems=new Set(near.map(e=>e.sourceSystem));
      if(categories.size<2||sourceSystems.size<2)continue;
      const supportingAssociations=associations.filter(e=>e.sourceId===anchor&&near.some(n=>n.sourceId===e.targetId||n.targetId===e.targetId));
      emit('TEMPORAL_CORRELATION',[...near,...supportingAssociations],{anchor,categories:[...categories],sourceSystems:[...sourceSystems],windowMs:R.proximityMs},'Independently evidenced activities connected to the same entity occur close in time; temporal proximity does not imply causation.');
      if(categories.size>=3)emit('MULTI_SOURCE_ASSOCIATION',[...near,...supportingAssociations],{anchor,categories:[...categories],sourceSystems:[...sourceSystems]},'Communication, financial and location sources independently support a time-local association.');
    }
  }
  for(const metric of network.metrics) {
    const support=edges.filter(e=>e.sourceId===metric.entityId||e.targetId===metric.entityId);
    if(metric.degree>=R.highDegree)emit('HIGH_NETWORK_CONNECTIVITY',support,{entityId:metric.entityId,degree:metric.degree,threshold:R.highDegree},'Entity is highly connected in the current case graph.');
    if(metric.betweenness>=R.bridgeBetweenness&&new Set(support.flatMap(e=>[metricMap.get(e.sourceId)?.communityId,metricMap.get(e.targetId)?.communityId])).size>=2)
      emit('CROSS_COMMUNITY_BRIDGE',support,{entityId:metric.entityId,betweenness:metric.betweenness,threshold:R.bridgeBetweenness},'A bridge entity lies on shortest paths and connects computed communities.');
  }
  const temporal=activity(edges);
  for(const bucket of temporal.buckets)if(bucket.count>=R.minimumBurst)emit('TEMPORAL_BURST',edges.filter(e=>bucket.relationshipIds.includes(e.id)),{count:bucket.count,eventType:bucket.type,windowMs:R.windowMs},'A burst of source-timestamped relationship activity is observed.');
  return {signals:[...signals.values()],summary:{communication,financial:{transactions:transfers.length,knownAmounts:amounts.length},locationChains,activity:temporal}};
}
