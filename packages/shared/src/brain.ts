import type { EntityType } from './index';
export type FindingKind = 'FACT' | 'INFERENCE' | 'SIGNAL';
export const RELATIONSHIP_TYPES = ['ASSOCIATED_WITH_PHONE','ASSOCIATED_WITH_VEHICLE','OWNS','ASSOCIATED_WITH_ACCOUNT',
  'ASSOCIATED_WITH','WORKS_FOR','MEMBER_OF','SEEN_AT','VISITED','MENTIONED_IN','CALLED','COMMUNICATED_WITH','TRANSFERRED_TO'] as const;
export type RelationshipType = typeof RELATIONSHIP_TYPES[number];
export interface GraphNode { id: string; caseId: string; entityType: EntityType; label: string }
export interface GraphEdge {
  id: string; caseId: string; sourceId: string; targetId: string; type: RelationshipType;
  direction: 'DIRECTED'; confidence: number; strength: number; findingKind: FindingKind;
  occurredAt: string | null; observedAt: string | null; endAt: string | null;
  sourceSystem: string; sourceRecordIds: string[]; evidenceRefs: EvidenceRef[];
  attributes: Record<string,unknown>;
}
export interface EvidenceRef { evidenceRecordId: string; documentId: string | null; sourceRecordId: string; sourceLocation: unknown; contentHash: string }
export interface CaseGraph { nodes: GraphNode[]; edges: GraphEdge[] }
export interface NodeMetrics { entityId: string; degree: number; degreeCentrality: number; betweenness: number; pageRank: number; communityId: string }
export interface NetworkResult { metrics: NodeMetrics[]; communities: { id: string; members: string[]; size: number }[]; algorithm: string; version: string }
export interface SignalInput {
  type: string; entityIds: string[]; relationshipIds: string[]; evidenceRefs: EvidenceRef[];
  strength: number; confidence: number; timeFrom: string | null; timeTo: string | null;
  findingKind: 'SIGNAL'; rule: string; version: string; parameters: Record<string,unknown>;
  reason: { description: string; metrics: Record<string,unknown>; caution: string };
}
