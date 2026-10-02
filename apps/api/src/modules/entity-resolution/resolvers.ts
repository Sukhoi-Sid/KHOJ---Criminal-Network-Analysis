import { MentionType, type EntityType, type EntityIdentifiers, type ResolutionSignal, type ResolutionStatus, type IdentifierKind } from '@sih/shared';
import { ValidationError } from '../../core/errors';

// Scores are deterministic rule scores, NOT probabilities.
export const RESOLUTION_RULES = {
  version: 'phase4-v1', autoThreshold: 0.90, reviewThreshold: 0.45,
  exactIdentifierScore: 0.99, nameOnlyScore: 0.55, phoneNameScore: 0.94,
  multipleSupportScore: 0.92, conflictScore: 0.10,
  compatibleName: 0.55, strongName: 0.8, textSimilarity: 0.8, initialsSimilarity: 0.75,
  phoneOnlyScore: 0.65, maxRecords: 2000, maxPairs: 50000,
} as const;
export interface MatchRecord {
  id: string; entityType: EntityType; normalizedValue: string; validIdentifier: boolean; identifiers: EntityIdentifiers;
}
export interface MatchResult { score: number; status: ResolutionStatus; signals: ResolutionSignal[]; conflicts: ResolutionSignal[] }
export interface EntityResolver {
  block(record: MatchRecord): string[];
  compare(left: MatchRecord, right: MatchRecord): MatchResult;
}

function editSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j-1] + 1, diagonal + Number(a[i-1] !== b[j-1])); diagonal = old;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}
export function nameSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const tokens = (v: string) => v.replace(/\./g, '').split(/\s+/);
  const left = tokens(a), right = tokens(b);
  const initialsCompatible = left.length === right.length && left.every((v,i) => v === right[i] ||
    (Math.min(v.length,right[i].length) === 1 && v[0] === right[i][0]));
  if (initialsCompatible) return RESOLUTION_RULES.initialsSimilarity;
  return editSimilarity(a.slice(0,256), b.slice(0,256));
}
const signal = (field: string, strength: ResolutionSignal['strength'], detail: string): ResolutionSignal => ({ field, strength, detail });
function identifierSignals(a: MatchRecord, b: MatchRecord) {
  const signals: ResolutionSignal[] = [], conflicts: ResolutionSignal[] = [];
  for (const key of ['phone','dob','governmentId','address','account','vehicle','organization','bank'] as IdentifierKind[]) {
    const av = a.identifiers[key] ?? [], bv = b.identifiers[key] ?? [];
    if (!av.length || !bv.length) continue;
    const shared = av.filter(v => bv.includes(v));
    if (shared.length) signals.push(signal(key, ['phone','governmentId','account','vehicle'].includes(key) ? 'strong' : 'supporting', `Shared normalized ${key}: ${shared.join(', ')}`));
    // Conservative: do not infer multiple phones/DOBs/ownership refer to one identity.
    if (!shared.length || (['dob','governmentId','bank'].includes(key) && (av.length !== 1 || bv.length !== 1))) {
      conflicts.push(signal(key, 'conflict', `Different source values: ${av.join(', ')} versus ${bv.join(', ')}`));
    }
  }
  return { signals, conflicts };
}

const person: EntityResolver = {
  block: r => {
    const names = r.normalizedValue.replace(/\./g,'').split(' ');
    return [`name:${r.normalizedValue}`, `initial:${names[0]?.[0]}:${names.at(-1)?.slice(0,3)}`, `first:${names[0]}`,
      ...(r.identifiers.phone ?? []).map(v => `phone:${v}`), ...(r.identifiers.governmentId ?? []).map(v => `governmentId:${v}`)];
  },
  compare: (a,b) => {
    const { signals, conflicts } = identifierSignals(a,b);
    const name = nameSimilarity(a.normalizedValue,b.normalizedValue);
    if (name >= RESOLUTION_RULES.compatibleName) signals.push(signal('name','supporting', `Name similarity ${name.toFixed(3)}; names alone do not establish identity.`));
    const has = (field: string) => signals.some(s => s.field === field);
    if (conflicts.length) return { score: RESOLUTION_RULES.conflictScore, status: 'DISTINCT', signals, conflicts };
    const score = has('governmentId') ? RESOLUTION_RULES.exactIdentifierScore
      : has('phone') && name >= RESOLUTION_RULES.compatibleName ? RESOLUTION_RULES.phoneNameScore
      : has('dob') && has('address') && name >= RESOLUTION_RULES.strongName ? RESOLUTION_RULES.multipleSupportScore
      : Math.max(name >= RESOLUTION_RULES.compatibleName ? RESOLUTION_RULES.nameOnlyScore * name : 0, has('phone') ? RESOLUTION_RULES.phoneOnlyScore : 0);
    return { score, status: score >= RESOLUTION_RULES.autoThreshold ? 'AUTO_RESOLVED' : score >= RESOLUTION_RULES.reviewThreshold || name >= RESOLUTION_RULES.compatibleName ? 'REVIEW_REQUIRED' : 'UNRESOLVED', signals, conflicts };
  },
};
const exact: EntityResolver = {
  block: r => r.validIdentifier ? [`exact:${r.normalizedValue}`] : [],
  compare: (a,b) => {
    const { signals, conflicts } = identifierSignals(a,b);
    const equal = a.validIdentifier && b.validIdentifier && a.normalizedValue === b.normalizedValue;
    if (equal) signals.push(signal('identifier','strong','Exact valid normalized identifier.'));
    return { score: conflicts.length ? RESOLUTION_RULES.conflictScore : equal ? RESOLUTION_RULES.exactIdentifierScore : 0,
      status: conflicts.length ? 'DISTINCT' : equal ? 'AUTO_RESOLVED' : 'UNRESOLVED', signals, conflicts };
  },
};
const conservativeText: EntityResolver = {
  block: r => [`text:${r.normalizedValue}`, `prefix:${r.normalizedValue.slice(0,4)}`],
  compare: (a,b) => {
    const score = nameSimilarity(a.normalizedValue,b.normalizedValue);
    return { score: score >= RESOLUTION_RULES.textSimilarity ? RESOLUTION_RULES.nameOnlyScore * score : 0,
      status: score >= RESOLUTION_RULES.textSimilarity ? 'REVIEW_REQUIRED' : 'UNRESOLVED',
      signals: score >= RESOLUTION_RULES.textSimilarity ? [signal('text','supporting',`Text similarity ${score.toFixed(3)} requires identity review.`)] : [], conflicts: [] };
  },
};
export const entityResolvers: Record<EntityType, EntityResolver> = {
  [MentionType.PERSON]: person, [MentionType.PHONE]: exact, [MentionType.VEHICLE]: exact,
  [MentionType.MONEY]: exact, [MentionType.LOCATION]: conservativeText,
  [MentionType.ORGANIZATION]: conservativeText, [MentionType.CASE_IDENTIFIER]: exact,
};
export function candidatePairs(records: MatchRecord[]): [MatchRecord, MatchRecord][] {
  if (records.length > RESOLUTION_RULES.maxRecords) throw new ValidationError('Case exceeds the MVP record limit; narrow the input before integration.');
  const blocks = new Map<string, MatchRecord[]>(), pairs = new Map<string,[MatchRecord,MatchRecord]>();
  for (const record of records) for (const key of entityResolvers[record.entityType].block(record)) {
    const blockKey = `${record.entityType}:${key}`;
    const prior = blocks.get(blockKey) ?? [];
    for (const other of prior) {
      const [left,right] = [record,other].sort((a,b) => a.id.localeCompare(b.id));
      pairs.set(`${left.id}:${right.id}`, [left,right]);
      if (pairs.size > RESOLUTION_RULES.maxPairs) throw new ValidationError('Candidate block exceeds the MVP comparison limit; refine source records.');
    }
    prior.push(record); blocks.set(blockKey,prior);
  }
  return [...pairs.values()];
}
