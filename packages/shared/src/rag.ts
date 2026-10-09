import type { EvidenceRef, FindingKind } from './brain';

export type InvestigativeIntent = 'CONNECTION'|'KEY_ENTITY'|'TEMPORAL'|'COMMUNICATION'|'FINANCIAL'|'LOCATION'|'EVIDENCE'|'ENTITY_SIGNALS'|'UNCERTAINTY'|'GUILT_REQUEST'|'GENERAL';
export type CitationKind = 'EVIDENCE'|'ENTITY'|'RELATIONSHIP'|'SIGNAL'|'TEMPORAL_EVENT'|'NETWORK_METRIC';
export interface InvestigativeCitation {
  id:string; kind:CitationKind; label:string; entityId?:string; relationshipId?:string; signalId?:string;
  evidenceRecordId?:string; documentId?:string|null; sourceRecordId?:string; sourceLocation?:unknown;
}
export interface InvestigativeClaim {
  id:string; findingKind:FindingKind|'UNKNOWN'; statement:string; confidence:number|null; citationIds:string[];
}
export interface InvestigativeEntity {id:string;type:string;label:string}
export interface InvestigativeAnswer {
  requestId:string; intent:InvestigativeIntent; answer:string; facts:InvestigativeClaim[];
  inferences:InvestigativeClaim[]; signals:InvestigativeClaim[]; citations:InvestigativeCitation[];
  entities:InvestigativeEntity[]; answerQuality:{groundedClaims:number;totalClaims:number;retrievalTypes:string[];provider:string;model:string;fallbackUsed:boolean};
  limitations:string[]; generatedAt:string;
}
export interface InvestigativeAskRequest {
  question:string; entityIds?:string[]; from?:string; to?:string; conversation?:{lastEntityId?:string};
}
export interface GroundedProviderInput {
  intent:InvestigativeIntent; facts:InvestigativeClaim[]; inferences:InvestigativeClaim[];
  signals:InvestigativeClaim[]; limitations:string[];
}
export interface GroundedProviderOutput {answer:string}

export type EvidenceBoundReference = EvidenceRef;
