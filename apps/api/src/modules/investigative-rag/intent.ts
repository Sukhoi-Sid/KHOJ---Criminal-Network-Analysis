import type { InvestigativeIntent } from '@sih/shared';

const rules:[InvestigativeIntent,RegExp][]=[
  ['GUILT_REQUEST',/\b(guilty|commit(?:ted)? the crime|criminal|culprit)\b/i],
  ['CONNECTION',/\b(connect(?:ed|ion)?|path|chain|linked?|relationship between)\b/i],
  ['KEY_ENTITY',/\b(key entit|important|bridge|centrality|network[- ]relevant|pagerank)\b/i],
  ['TEMPORAL',/\b(when|timeline|happened|around|between|time window|chronolog)\b/i],
  ['COMMUNICATION',/\b(calls?|communications?|contacts?|phones?|spike|reciprocity)\b/i],
  ['FINANCIAL',/\b(financial|transaction|transfer|account|money|amount|fund)\b/i],
  ['LOCATION',/\b(location|co-?location|place|seen at|visited|where)\b/i],
  ['EVIDENCE',/\b(evidence|support(?:s|ing)?|source|provenance|citation)\b/i],
  ['ENTITY_SIGNALS',/\b(signals?|anomal(?:y|ies)|patterns?|unusual)\b/i],
  ['UNCERTAINTY',/\b(uncertain|conflict|unknown|insufficient|unresolved)\b/i],
];
export const injectionLike=(question:string)=>/ignore (?:all |the )?(?:previous|system)|system prompt|developer message|reveal .*secret|password|credential|raw (?:sql|cypher)|drop table|match \(n\)/i.test(question);
export function analyzeIntent(question:string):InvestigativeIntent {return rules.find(([,rule])=>rule.test(question))?.[0]??'GENERAL';}
