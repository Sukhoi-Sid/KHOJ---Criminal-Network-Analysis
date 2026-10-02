// ─── Roles & Permissions ───────────────────────────────────────────────────
export * from './brain';

export enum UserRole {
  INVESTIGATOR = 'investigator',
  SUPERVISOR = 'supervisor',
  AUDITOR = 'auditor',
  ADMIN = 'admin',
}

export enum Permission {
  CASE_CREATE = 'case:create',
  CASE_READ = 'case:read',
  CASE_UPDATE = 'case:update',
  CASE_ASSIGN = 'case:assign',
  AUDIT_READ = 'audit:read',
  USER_MANAGE = 'user:manage',
  EVIDENCE_READ = 'evidence:read',
  EVIDENCE_WRITE = 'evidence:write',
  INTELLIGENCE_READ = 'intelligence:read',
  INTELLIGENCE_WRITE = 'intelligence:write',
  INTELLIGENCE_AUTHORIZE = 'intelligence:authorize',
  SOURCE_FINANCIAL = 'source:financial',
  SOURCE_CDR = 'source:cdr',
  SOURCE_CRIMINAL_HISTORY = 'source:criminal-history',
  SOURCE_VEHICLE = 'source:vehicle',
  SOURCE_LOCATION = 'source:location',
  SOURCE_CYBER = 'source:cyber',
  ENTITY_READ = 'entity:read',
  ENTITY_RESOLVE = 'entity:resolve',
  BRAIN_READ = 'brain:read',
  BRAIN_EXECUTE = 'brain:execute',
}

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  [UserRole.INVESTIGATOR]: [
    Permission.BRAIN_READ,
    Permission.BRAIN_EXECUTE,
    Permission.ENTITY_READ,
    Permission.ENTITY_RESOLVE,
    Permission.CASE_CREATE,
    Permission.CASE_READ,
    Permission.CASE_UPDATE,
    Permission.EVIDENCE_READ,
    Permission.EVIDENCE_WRITE,
    Permission.INTELLIGENCE_READ,
    Permission.INTELLIGENCE_WRITE,
    Permission.SOURCE_FINANCIAL,
    Permission.SOURCE_CDR,
    Permission.SOURCE_CRIMINAL_HISTORY,
    Permission.SOURCE_VEHICLE,
    Permission.SOURCE_LOCATION,
    Permission.SOURCE_CYBER,
  ],
  [UserRole.SUPERVISOR]: [
    Permission.BRAIN_READ,
    Permission.BRAIN_EXECUTE,
    Permission.ENTITY_READ,
    Permission.ENTITY_RESOLVE,
    Permission.CASE_CREATE,
    Permission.CASE_READ,
    Permission.CASE_UPDATE,
    Permission.CASE_ASSIGN,
    Permission.INTELLIGENCE_READ,
    Permission.INTELLIGENCE_WRITE,
    Permission.INTELLIGENCE_AUTHORIZE,
    Permission.SOURCE_FINANCIAL,
    Permission.SOURCE_CDR,
    Permission.SOURCE_CRIMINAL_HISTORY,
    Permission.SOURCE_VEHICLE,
    Permission.SOURCE_LOCATION,
    Permission.SOURCE_CYBER,
    Permission.EVIDENCE_READ,
    Permission.EVIDENCE_WRITE,
  ],
  [UserRole.AUDITOR]: [Permission.AUDIT_READ],
  [UserRole.ADMIN]: [Permission.USER_MANAGE],
};

// ─── Case ──────────────────────────────────────────────────────────────────

export enum CaseStatus {
  OPEN = 'open',
  ACTIVE = 'active',
  ON_HOLD = 'on_hold',
  CLOSED = 'closed',
}

export enum CaseClassification {
  RESTRICTED = 'restricted',
  CONFIDENTIAL = 'confidential',
  SECRET = 'secret',
}

export enum CaseAssignmentRole {
  INVESTIGATOR = 'investigator',
  SUPERVISOR = 'supervisor',
}

// ─── Audit ─────────────────────────────────────────────────────────────────

export enum AuditAction {
  LOGIN = 'login',
  LOGOUT = 'logout',
  LOGIN_FAILED = 'login_failed',
  CASE_CREATE = 'case_create',
  CASE_READ = 'case_read',
  CASE_UPDATE = 'case_update',
  CASE_ASSIGN = 'case_assign',
  EVIDENCE_DOCUMENT_CREATE = 'evidence_document_create',
  EVIDENCE_DOCUMENT_READ = 'evidence_document_read',
  DOCUMENT_PROCESS = 'document_process',
  USER_CREATE = 'user_create',
  USER_UPDATE = 'user_update',
  AUDIT_READ = 'audit_read',
  ACCESS_DENIED = 'access_denied',
  INTELLIGENCE_ANALYZE = 'intelligence_analyze',
  INTELLIGENCE_READ = 'intelligence_read',
  INTELLIGENCE_REVIEW = 'intelligence_review',
  INTELLIGENCE_REQUEST_CREATE = 'intelligence_request_create',
  INTELLIGENCE_TRANSITION = 'intelligence_transition',
  ENTITY_INTEGRATE = 'entity_integrate',
  ENTITY_READ = 'entity_read',
  ENTITY_REVIEW = 'entity_review',
  GRAPH_SYNC = 'graph_sync',
  BRAIN_ANALYZE = 'brain_analyze',
  BRAIN_READ = 'brain_read',
}

export enum AuditResourceType {
  USER = 'user',
  CASE = 'case',
  DOCUMENT = 'document',
  EVIDENCE = 'evidence',
  AUDIT = 'audit',
  SESSION = 'session',
  INTELLIGENCE_GAP = 'intelligence_gap',
  INTELLIGENCE_REQUEST = 'intelligence_request',
  CANONICAL_ENTITY = 'canonical_entity',
  RESOLUTION_CANDIDATE = 'resolution_candidate',
  CASE_GRAPH = 'case_graph',
  ANALYTICAL_SIGNAL = 'analytical_signal',
}

// ─── Evidence Store ────────────────────────────────────────────────────────

export enum EvidenceSourceType {
  FIR_UPLOAD = 'fir_upload',
  REPORT_UPLOAD = 'report_upload',
  ATTACHMENT = 'attachment',
  EXTERNAL_PACKAGE = 'external_package',
}

export enum ReliabilityTier {
  TIER1_AUTHORITATIVE = 'tier1_authoritative',
  TIER2_OPERATIONAL = 'tier2_operational',
  TIER3_DERIVED = 'tier3_derived',
  TIER4_UNVERIFIED = 'tier4_unverified',
}

// ─── Document Intelligence (Phase 2) ──────────────────────────────────────
// Derived, NOT source of truth — see docs/architecture/SYSTEM-ARCHITECTURE.md
// §3. Evidence (above) remains authoritative; mentions are extracted,
// pending-resolution references to it.

export enum DocumentProcessingStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum MentionType {
  PERSON = 'person',
  PHONE = 'phone',
  VEHICLE = 'vehicle',
  LOCATION = 'location',
  ORGANIZATION = 'organization',
  CASE_IDENTIFIER = 'case_identifier',
  DATE = 'date',
  MONEY = 'money',
}

export enum ExtractionMethod {
  REGEX = 'regex',
  LLM = 'llm',
}

// ─── API DTOs ──────────────────────────────────────────────────────────────

export interface UserDto {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
}

export interface AuthLoginRequest {
  email: string;
  password: string;
}

export interface AuthLoginResponse {
  token: string;
  user: UserDto;
}

export interface CaseDto {
  id: string;
  caseId: string;
  title: string;
  description: string | null;
  status: CaseStatus;
  classification: CaseClassification;
  jurisdiction: string | null;
  contextSummary: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  assignments?: CaseAssignmentDto[];
}

export interface CaseAssignmentDto {
  id: string;
  userId: string;
  role: CaseAssignmentRole;
  user?: Pick<UserDto, 'id' | 'name' | 'email' | 'role'>;
}

export interface CreateCaseRequest {
  title: string;
  description?: string;
  classification?: CaseClassification;
  jurisdiction?: string;
  contextSummary?: string;
}

export interface UpdateCaseRequest {
  title?: string;
  description?: string;
  status?: CaseStatus;
  classification?: CaseClassification;
  jurisdiction?: string;
  contextSummary?: string;
}

export interface AssignCaseRequest {
  userId: string;
  role: CaseAssignmentRole;
}

export interface AuditEventDto {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId: string | null;
  caseId: string | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

export interface DocumentDto {
  id: string;
  caseId: string;
  filename: string;
  mimeType: string;
  contentHash: string;
  sourceType: EvidenceSourceType;
  uploadedById: string;
  createdAt: string;
  processingStatus: DocumentProcessingStatus;
  processingError: string | null;
  processedAt: string | null;
}

export interface EvidenceRecordDto {
  id: string;
  caseId: string;
  documentId: string | null;
  sourceType: EvidenceSourceType;
  sourceRecordId: string;
  reliabilityTier: ReliabilityTier;
  contentHash: string;
  createdAt: string;
  provenance?: ProvenanceDto;
}

export interface ProvenanceDto {
  id: string;
  originSource: string;
  receivedAt: string;
  receivedById: string;
  transformationChain: unknown[];
  parentEvidenceId: string | null;
  contentHash: string;
}

// A raw, un-resolved reference extracted from a document — "Mention" per
// docs/architecture/SYSTEM-ARCHITECTURE.md §12 ("raw extracted reference
// before resolution"). Never authoritative; always traceable to its source
// document/evidence record + location. Entity Resolution (Phase 4) is what
// eventually turns these into InvestigativeEntity records — Phase 2 stops here.
export interface MentionDto {
  id: string;
  caseId: string;
  documentId: string;
  evidenceRecordId: string | null;
  mentionType: MentionType;
  text: string;
  normalizedText: string | null;
  confidence: number;
  pageNumber: number | null;
  startOffset: number | null;
  endOffset: number | null;
  extractionMethod: ExtractionMethod;
  extractedAt: string;
}

export interface ProcessDocumentResponse {
  document: DocumentDto;
  mentions: MentionDto[];
  /** true if a cached COMPLETED result was returned without re-extracting (idempotency). */
  reused: boolean;
}

export interface ApiError {
  error: string;
  code?: string;
  details?: unknown;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// Phase 3 API contracts. Security CaseClassification is intentionally unchanged.
export type IntelligenceGapStatus = 'OPEN' | 'REVIEWED' | 'DISMISSED' | 'REQUESTED' | 'RESOLVED' | 'STALE';
export type IntelligencePriority = 'HIGH' | 'MEDIUM' | 'LOW';
export type IntelligenceRequestStatus = 'DRAFT' | 'SUBMITTED' | 'PENDING_AUTHORIZATION' | 'AUTHORIZED' | 'REJECTED' | 'DISPATCHED' | 'RECEIVED' | 'COMPLETED' | 'FAILED';
export interface IntelligenceSourceDto {
  id: string; department: string; category: string; permission: string; synthetic: boolean;
}
export interface IntelligenceGapDto {
  id: string; caseId: string; caseType: string; ruleId: string;
  requiredData: string; targetType: string; targetEntity: string; sourceId: string;
  source: IntelligenceSourceDto; timeFrom: string; timeTo: string; purpose: string;
  priority: IntelligencePriority; priorityReason: string; explanation: string; status: IntelligenceGapStatus;
  reviewedById: string | null; reviewedAt: string | null; reviewNote: string | null;
  origins: Array<{ id: string; documentId: string; evidenceRecordId: string | null; mentionId: string | null; snapshot: unknown }>;
  createdAt: string; updatedAt: string;
}
export interface IntelligenceRequestScope {
  caseType: string; requiredData: string; targetType: string; targetEntity: string; sourceId: string;
  timeFrom: string; timeTo: string; purpose: string; explanation: string;
  priority: string; priorityReason: string; reviewedById: string; reviewedAt: string; origins: unknown[];
}
export interface IntelligenceRequestDto {
  id: string; caseId: string; gapId: string; sourceId: string; scope: IntelligenceRequestScope;
  status: IntelligenceRequestStatus; createdById: string; failureReason: string | null;
  createdAt: string; updatedAt: string;
}
export interface ReviewIntelligenceGapRequest { decision: 'select' | 'dismiss'; note: string }
export interface CreateIntelligenceRequest { gapId: string }
export interface AuthorizeIntelligenceRequest { approved: boolean; reason: string }

// Phase 4 reuses MentionType. MONEY is accepted only for an identified account/payment identifier.
export const ENTITY_TYPES = [MentionType.PERSON, MentionType.PHONE, MentionType.VEHICLE, MentionType.MONEY,
  MentionType.LOCATION, MentionType.ORGANIZATION, MentionType.CASE_IDENTIFIER] as const;
export type EntityType = typeof ENTITY_TYPES[number];
export type ResolutionStatus = 'UNRESOLVED' | 'REVIEW_REQUIRED' | 'AUTO_RESOLVED' | 'ACCEPTED' | 'DISTINCT' | 'REJECTED';
export type IdentifierKind = 'phone' | 'dob' | 'address' | 'governmentId' | 'account' | 'vehicle' | 'organization' | 'bank';
export type EntityIdentifiers = Partial<Record<IdentifierKind, string[]>>;
export interface ResolutionSignal { field: string; strength: 'strong' | 'supporting' | 'conflict'; detail: string }
export interface ResolutionReviewRequest {
  decision: 'accept' | 'reject'; reason: string; expectedRevision: number; idempotencyKey: string;
}
export interface CanonicalEntityDto {
  id: string; caseId: string; entityType: EntityType; displayLabel: string; active: boolean;
  resolutionStatus: ResolutionStatus; confidence: number; createdAt: string; updatedAt: string;
}
