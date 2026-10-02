import type { ResolutionStatus } from '@sih/shared';
import { entityResolvers, type MatchRecord } from './resolvers';

export interface CandidateLink { id: string; leftId: string; rightId: string; status: ResolutionStatus; score: number }
export const pairKey = (a: string,b: string) => [a,b].sort().join(':');

export function conflictingGroups(left: MatchRecord[], right: MatchRecord[], candidates: CandidateLink[]): string[] {
  const distinct = new Set(candidates.filter(c => c.status === 'REJECTED' || c.status === 'DISTINCT').map(c => pairKey(c.leftId,c.rightId)));
  const reasons = new Set<string>();
  for (const a of left) for (const b of right) {
    if (a.id === b.id) continue;
    if (a.entityType !== b.entityType) reasons.add('Different entity types');
    else {
      if (distinct.has(pairKey(a.id,b.id))) reasons.add(`Existing distinct/rejected decision for ${pairKey(a.id,b.id)}`);
      for (const conflict of entityResolvers[a.entityType].compare(a,b).conflicts) reasons.add(`${a.id}/${b.id}: ${conflict.field}: ${conflict.detail}`);
    }
  }
  return [...reasons];
}

/** Disjoint-set grouping only: no analytical relationships or knowledge graph. */
export function clusterRecords(records: MatchRecord[], candidates: CandidateLink[]) {
  const parent = new Map(records.map(r => [r.id,r.id]));
  const groups = new Map(records.map(r => [r.id,[r]]));
  const root = (id: string): string => { const p = parent.get(id)!; if (p === id) return id; const r = root(p); parent.set(id,r); return r; };
  const blocked: { candidateId: string; reasons: string[] }[] = [];
  const accepted = candidates.filter(c => c.status === 'ACCEPTED' || c.status === 'AUTO_RESOLVED')
    .sort((a,b) => Number(b.status === 'ACCEPTED') - Number(a.status === 'ACCEPTED') || b.score-a.score || a.id.localeCompare(b.id));
  for (const candidate of accepted) {
    const a = root(candidate.leftId), b = root(candidate.rightId);
    if (a === b) continue;
    const conflicts = conflictingGroups(groups.get(a)!,groups.get(b)!,candidates);
    if (conflicts.length) { blocked.push({ candidateId: candidate.id, reasons: conflicts }); continue; }
    const merged = [...groups.get(a)!,...groups.get(b)!];
    parent.set(b,a); groups.set(a,merged); groups.delete(b);
  }
  return { groups: [...groups.values()], blocked };
}
