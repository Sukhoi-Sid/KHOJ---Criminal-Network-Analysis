import { ValidationError } from '../../../core/errors';
import { BRAIN_RULES as R } from '../rules';
import type { GraphEdge } from '../types';
export const eventTime=(e:GraphEdge)=>e.occurredAt??e.observedAt;
export interface TimelineFilter {entityId?:string;type?:string;from?:string;to?:string;offset?:number;limit?:number}
export function timeline(edges:GraphEdge[],filter:TimelineFilter={}) {
  const from=filter.from?Date.parse(filter.from):-Infinity,to=filter.to?Date.parse(filter.to):Infinity;
  if(Number.isNaN(from)||Number.isNaN(to)||from>to) throw new ValidationError('Invalid chronological window');
  const selected=edges.filter(e=>(!filter.entityId||e.sourceId===filter.entityId||e.targetId===filter.entityId)&&(!filter.type||e.type===filter.type)&&
    ((!filter.from&&!filter.to)||(eventTime(e)!==null&&Date.parse(eventTime(e)!)>=from&&Date.parse(eventTime(e)!)<=to)))
    .sort((a,b)=>(eventTime(a)?Date.parse(eventTime(a)!):Infinity)-(eventTime(b)?Date.parse(eventTime(b)!):Infinity)||a.id.localeCompare(b.id));
  const offset=filter.offset??0,limit=filter.limit??50;
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>R.maxResults) throw new ValidationError('Invalid timeline page');
  return {items:selected.slice(offset,offset+limit).map(e=>({...e,timeSemantics:e.occurredAt?'occurredAt':e.observedAt?'observedAt':'unknown'})),total:selected.length,offset,limit};
}
export function activity(edges:GraphEdge[]) {
  const buckets=new Map<string,{start:string;type:string;count:number;relationshipIds:string[]}>();
  for(const e of edges) {const time=eventTime(e);if(!time)continue;const start=new Date(Math.floor(Date.parse(time)/R.windowMs)*R.windowMs).toISOString();
    const key=`${e.type}:${start}`,bucket=buckets.get(key)??{start,type:e.type,count:0,relationshipIds:[]};bucket.count++;bucket.relationshipIds.push(e.id);buckets.set(key,bucket);}
  return {buckets:[...buckets.values()].sort((a,b)=>a.start.localeCompare(b.start)||a.type.localeCompare(b.type)),missingTimestamps:edges.filter(e=>!eventTime(e)).length,windowMs:R.windowMs};
}
