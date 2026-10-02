# Implementation Blueprint

**Project:** SIH 26189 – Criminal  
**Status:** FROZEN — Implementation Source of Truth  
**Based on:** [SYSTEM-ARCHITECTURE.md](../architecture/SYSTEM-ARCHITECTURE.md)  
**Last approved:** September 2026

---

## Frozen Principles Verification

| Principle | Blueprint enforcement |
|---|---|
| Evidence Store = source of truth | Dedicated `evidence-store` module; graph/findings reference evidence IDs |
| Graph is derived | Neo4j populated by `graph-builder`; rebuildable from evidence; never authoritative |
| Investigation is iterative | Case Intelligence State + re-analysis triggers + investigator seeds |
| External data request-mediated | All external data via `DataExchangeGateway` + approved requests |
| Case-scoped & connected | All domain objects carry `caseId`; shared Case Intelligence State |
| Findings evidence-grounded | Finding assembly requires evidence chain; RAG retrieval-first |
| Human in the loop | Approval workflow, merge review queue, finding dismiss/annotate |
| Security/audit cross-cutting | Middleware + audit emitter on every module |
| Blockchain = integrity only | `integrity` module anchors hashes; no raw PII on-chain |

---

## 1. Project / Module Structure

```
sih-26189-criminal/
├── docs/                              # Design source of truth (FROZEN)
├── packages/
│   └── shared/                        # Shared domain types, enums, contracts
├── apps/
│   ├── api/                           # Modular monolith backend
│   │   └── src/
│   │       ├── modules/               # Logical modules (see §3)
│   │       ├── core/                  # Config, DB, events, middleware
│   │       └── main.ts
│   └── web/                           # Investigator Command Center (Phase 8)
├── mock-data/                         # Synthetic source payloads + sample FIRs
└── scripts/                           # Seed demo cases, hash verification helpers
```

**Monorepo:** npm/pnpm workspaces (D2). One backend app, one frontend app. Logical modules inside `apps/api/src/modules/` — not separate deployables.

---

## 2. Frontend / Backend Boundaries

| Layer | Responsibility | Does NOT |
|---|---|---|
| **Frontend (`apps/web`)** | Case UI, graph (Cytoscape.js), timeline, requests, evidence viewer, integrity badges, annotations | Intelligence reasoning, resolution, graph computation, external source access |
| **Backend (`apps/api`)** | Domain logic, Brain pipeline, evidence storage, auth, audit, mock gateway | Presentation beyond API shaping |
| **Shared (`packages/shared`)** | Domain enums, DTO shapes, finding types, relationship types | Business logic |

**Communication:** REST (primary MVP). Frontend → backend API only.

---

## 3. Internal Modules & Responsibilities

```
apps/api/src/modules/
├── core/                    # DB connections (PostgreSQL, Neo4j), in-process event bus
├── auth/                    # Authentication, RBAC, case/source policies
├── audit/                   # Append-only audit log emitter + query
├── case-platform/           # Phase 1 — cases, assignments, case state
├── evidence-store/          # Source of truth — documents, packages, evidence records
├── document-intelligence/   # Phase 2 — ingest, extract (PDF/text MVP; extensible OCR)
├── intelligence-requirements/ # Phase 3 — gap analysis, request formulation
├── data-exchange/           # Phase 3 — gateway + source adapters
├── entity-resolution/       # Phase 4 — normalize, match, merge/split
├── intelligence-brain/      # Phases 5–7 — pipeline orchestrator
│   ├── graph-builder/       # Phase 5 — derived Neo4j graph construction
│   ├── analytics/           # Phase 6 — network, temporal, pattern
│   └── explainability/      # Phase 7 — findings assembly, RAG
├── integrity/               # Phase 9 — local hash ledger, verification
└── mock-sources/            # MVP mock adapters (part of data-exchange boundary)
```

| Module | Owns |
|---|---|
| `case-platform` | Case lifecycle, assignment, Case Intelligence State, seeds/hypotheses |
| `evidence-store` | Raw documents, external packages (immutable), evidence records, provenance |
| `document-intelligence` | Extraction jobs, mention records; **PDF/text MVP**; extensible for scanned/Hindi |
| `intelligence-requirements` | Gap records, request CRUD, approval state machine |
| `data-exchange` | Request submission, adapter routing, response validation, package receipt |
| `entity-resolution` | Normalization, match candidates, merge decisions, review queue |
| `intelligence-brain` | Pipeline orchestration, re-analysis, finding generation |
| `graph-builder` | Derived Neo4j nodes/edges/events (rebuildable) |
| `analytics` | Network scores, temporal correlations, pattern signals |
| `explainability` | Finding objects, NL Q&A with citations via LLM provider abstraction |
| `auth` + `audit` | Cross-cutting |
| `integrity` | Hash compute, local anchor, verify |

---

## 4. Data Storage Responsibilities

| Store | Technology | Holds | Authority |
|---|---|---|---|
| **Primary DB** | PostgreSQL | Cases, users, roles, requests, mentions, resolved entities, findings, audit, integrity metadata | Operational + metadata |
| **Evidence Blob Store** | Local filesystem or S3-compatible | Original FIR files, raw external response JSON | **Source of truth (content)** |
| **Evidence Index** | PostgreSQL (`evidence-store`) | Evidence metadata, provenance chains, blob pointers | **Source of truth (index)** |
| **Knowledge Graph** | **Neo4j (D1)** | Case-scoped derived nodes, edges, events | **Derived only — rebuildable** |
| **Vector Index** (optional MVP) | pgvector in PostgreSQL | Embeddings for RAG | Derived; rebuildable |
| **Integrity Ledger** | PostgreSQL (`integrity` module) | Hash anchors — **local ledger MVP (D4)** | Integrity proofs |

**Rule:** If Neo4j graph and evidence disagree → evidence wins → trigger graph rebuild.

---

## 5. Conceptual Data Models & Connections

```
Case
  ├── has many → Document (evidence-store)
  ├── has many → Extraction → Mention
  ├── has many → IntelligenceRequest
  ├── has many → ExternalDataPackage (immutable)
  ├── has many → InvestigativeEntity (post-resolution)
  ├── has many → Relationship (derived in Neo4j, evidence-backed)
  ├── has many → Event (timeline)
  ├── has many → Signal (analytical)
  ├── has many → Finding
  ├── has many → InvestigatorSeed / Note
  ├── has many → AuditEvent
  └── has one  → CaseIntelligenceState (versioned)

Finding
  ├── classification: FACT | INFERENCE | SIGNAL
  ├── evidence_chain[] → Evidence
  ├── optional graph_path[] → Neo4j relationship chain
  └── optional inference_chain[]

IntelligenceRequest
  ├── caseId, subjectEntityId, dataCategory, purpose, timePeriod
  ├── targetSource, status, approvedBy
  └── fulfilledBy → ExternalDataPackage

Evidence
  ├── sourceType, sourceRecordId, blobPointer, reliabilityTier
  ├── provenance → ProvenanceRecord
  └── optional → IntegrityAnchor
```

---

## 6. API / Domain Contract Boundaries

### External API (Frontend → Backend)

| Domain group | Purpose |
|---|---|
| **Auth** | Login, session, current user |
| **Cases** | CRUD, assign, status, intelligence state summary |
| **Documents** | Upload, list, metadata, trigger extraction |
| **Entities** | Resolved entities, aliases, merge review actions |
| **Intelligence Requests** | Gaps/suggestions, create, approve, reject, submit |
| **Graph** | Fetch derived Neo4j graph (filtered) |
| **Timeline** | Events ordered by time |
| **Signals** | Pattern/anomaly signals with rationale |
| **Findings** | List, detail, dismiss, annotate |
| **Investigation Loop** | Add seed/hypothesis, trigger re-analysis |
| **Ask** | NL question → grounded answer + citations |
| **Evidence** | View source record, provenance chain |
| **Audit** | Query audit log (role-gated) |
| **Integrity** | Verify hash for document/package/finding |

### Internal Domain Interfaces

| Interface | Provider | Consumers |
|---|---|---|
| `IEvidenceStore` | evidence-store | All modules |
| `ICaseService` | case-platform | All modules |
| `IDocumentProcessor` | document-intelligence | case-platform, brain |
| `IGapAnalyzer` | intelligence-requirements | document-intelligence, brain |
| `IIntelligenceRequestService` | intelligence-requirements | data-exchange, UI |
| `IDataExchangeGateway` | data-exchange | intelligence-requirements |
| `ISourceAdapter` | mock-sources / future adapters | data-exchange |
| `IEntityResolver` | entity-resolution | brain, data-exchange |
| `IBrainPipeline` | intelligence-brain | case-platform, data-exchange, UI |
| `IGraphQuery` | graph-builder | analytics, explainability, UI |
| `IAnalyticsEngine` | analytics | brain |
| `IExplainabilityService` | explainability | UI |
| `ILLMProvider` | core (abstraction) | document-intelligence, explainability |
| `IAuditEmitter` | audit | All modules |
| `IIntegrityService` | integrity | evidence-store, audit |

### Domain Events (In-Process)

```
DocumentIngested
ExtractionCompleted
GapsIdentified
IntelligenceRequestApproved
ExternalDataReceived
EntityResolutionCompleted
GraphUpdated
SignalsGenerated
FindingsGenerated
ReAnalysisRequested
InvestigatorSeedAdded
FindingAnnotated
```

---

## 7. Intelligence Brain Pipeline Interfaces

**Entry:** `IBrainPipeline.run(caseId, trigger, options)`

| Trigger | When |
|---|---|
| `INITIAL` | First document processed |
| `DATA_RECEIVED` | External package ingested |
| `RE_ANALYSIS` | Investigator seed or manual trigger |
| `RESOLUTION_UPDATED` | Human confirmed/rejected merge |

### Stages

```
IBrainPipeline
  ├── IRelationshipExtractor.extract(caseId, resolvedEntities, evidence)
  ├── IProvenanceBinder.bind(candidates) → validated evidence links
  ├── IGraphBuilder.build(caseId, validated) → Neo4j snapshot
  ├── IAnalyticsEngine.analyze(caseId, graphSnapshot) → signals
  ├── IFindingAssembler.assemble(caseId, signals, graph) → findings
  └── IGapAnalyzer.feedback(caseId, graph, findings) → gap suggestions
```

**Contract rules:**
- Stages read from `IEvidenceStore` — never from Neo4j alone
- Graph builder writes derived Neo4j data; each edge requires `evidenceIds[]`
- Finding assembler rejects outputs without ≥1 evidence reference
- Gap feedback returns to `intelligence-requirements`

---

## 8. Intelligence Request & Mock External-Source Interface

**Phase 3 implementation update (2026-09-17):** The user-authorized case-type registry and requirement engine
are implemented within `intelligence-requirements`. The original conceptual lifecycle below maps to
`DRAFT → SUBMITTED → PENDING_AUTHORIZATION → AUTHORIZED → DISPATCHED → RECEIVED → COMPLETED`,
with `REJECTED` and retriable `FAILED` outcomes. Here SUBMITTED means submitted for internal approval;
DISPATCHED means submitted to a source. Both SUBMITTED and DISPATCHED are recorded in durable history.
Supervisor approval, source permissions, assignment-scoped access and provenance remain mandatory.
See [Phase 3 status](PHASE-3-STATUS.md) for implemented contracts, relevance rules and verification.

Case context is classified by registry signals. Requirements require a target justified by its local source text,
an explicit incident/transaction date window, a mapped source and an investigative purpose. Rules supply
explainable priority and scope limits. Review creates an immutable formal request; a changed context creates
new versioned gap suggestions and cannot silently alter an existing authorization. The six synthetic categories
are financial, telecom, criminal-history, vehicle, CCTV/location, and cyber. Receipt is owned by evidence-store.

### Request State Machine

```
DRAFT → PENDING_APPROVAL → APPROVED → SUBMITTED → FULFILLED | PARTIAL | REJECTED
                         ↘ REJECTED
```

### `ISourceAdapter` Contract

```
interface ISourceAdapter {
  sourceId: string                    // e.g. "mock-cdr", "mock-financial"
  supportedDataCategories: string[]
  validateRequest(request): ValidationResult
  submitRequest(request): SubmissionReceipt
  fetchResponse(receipt): ExternalDataPayload   // MVP: synchronous mock
}
```

### Mock Adapters (MVP)

| Adapter | Returns |
|---|---|
| `MockCDRAdapter` | Call/SMS records keyed by phone |
| `MockFinancialAdapter` | Transactions keyed by person/account |
| `MockCriminalHistoryAdapter` | Prior cases keyed by person |
| `MockVehicleAdapter` | Registration/ownership keyed by vehicle/person |
| `MockLocationAdapter` | Cell/CCTV events keyed by phone/person/location |

**Gateway flow:** validate approved request → adapter → hash → evidence-store → `ExternalDataReceived` → entity-resolution → brain re-analysis.

---

## 9. Evidence / Provenance Flow

```
Upload → Hash + Blob Store → Evidence Record + Provenance → [Integrity Anchor]
Approved Request → Adapter → Hash Payload → ExternalDataPackage → Evidence Records
Evidence → Extraction/Resolution → Derived Neo4j Edge/Finding (evidenceIds required) → UI
```

Every evidence item carries: `originSource`, `receivedAt`, `receivedBy`, `transformationChain[]`, `parentEvidenceId`, `contentHash`, optional `integrityAnchorId`.

---

## 10. Authentication, RBAC & Audit Boundaries

### Roles (MVP)

| Role | Access |
|---|---|
| `investigator` | Assigned cases, create requests, view findings, annotate |
| `supervisor` | Approve requests, view team cases |
| `auditor` | Audit logs + provenance read-only |
| `admin` | User management; no default case content access |

### ABAC

- Case: user assigned OR supervisor of team
- Source: e.g. `source:cdr` permission for CDR data
- Sensitive fields masked by role in API responses

### Audit (Append-Only)

Login, case/document access, request approve/submit, merge confirm/reject, finding dismiss, re-analysis trigger, integrity verify, export.

---

## 11. Blockchain / Integrity Integration Boundary

### Module: `integrity`

| Action | Detail |
|---|---|
| Compute SHA-256 | On evidence-store ingest |
| Anchor hash | Document, external package, approved request, audit batch |
| Verify | On-demand for UI badge |
| Store metadata | Local DB table (MVP); extensible to external ledger |

### On-Chain / Anchored vs Off-Chain

| Anchored (hash only) | Off-Chain |
|---|---|
| Document, package, request, audit batch, optional graph/finding snapshot hash | All raw content, Neo4j full graph, investigator notes |

---

## 12. Mock / Synthetic Data Strategy (D5)

**Primary demo:** **Operation Crosslink** — one complete scripted investigation completing the full iterative loop in ≤10 minutes.

### Demo Case Design

**Seed FIR:** 2 named persons, 1 phone, 1 vehicle, 1 location, 1 incident date.

| Entity in FIR | Mock sources reveal |
|---|---|
| Person A (accused) | CDR → calls Person B; vehicle registered; financial transfer to Org X |
| Person B | Criminal history; location pings near incident |
| Org X | Linked to Case REF-2024-118 |
| Incident date | CDR burst + co-location signal pre-incident |

### `mock-data/` Layout

```
mock-data/
├── firs/                    # Sample FIR PDF + text
├── cdr/                     # JSON keyed by phone
├── financial/               # JSON keyed by person/account
├── criminal-history/        # JSON keyed by person
├── vehicles/                # JSON keyed by registration
├── locations/               # JSON keyed by phone/person
├── organizations/           # Org linkage data
└── seed-script/             # Creates demo case
```

### Demo Loop

1. Open pre-seeded case or upload FIR
2. Review extracted entities
3. View system-suggested requests
4. Approve CDR + financial requests
5. Mock data returns → Neo4j graph updates
6. Explore network (Cytoscape.js), timeline, signals
7. Ask: "How is Person A connected to Person B?"
8. Add investigator seed → new request → re-analysis
9. Show evidence chain + integrity verify on FIR

---

## 13. Nine Phases → Implementation Units

| Phase | Unit(s) | Deliverable |
|---|---|---|
| **1** | `case-platform`, `auth`, `audit`, `evidence-store` (skeleton) | Cases, users, RBAC, audit |
| **2** | `document-intelligence` | PDF/text upload, extract, mentions + provenance |
| **3** | `intelligence-requirements`, `data-exchange`, `mock-sources` | Gaps, requests, gateway, mocks |
| **4** | `entity-resolution` | Normalize, match, merge review |
| **5** | `intelligence-brain`, `graph-builder` | Derived Neo4j graph |
| **6** | `intelligence-brain/analytics` | Network, temporal, pattern signals |
| **7** | `intelligence-brain/explainability` | Findings, RAG Q&A |
| **8** | `apps/web` | Full investigator UI |
| **9** | `integrity` + audit anchoring | Hash, anchor, verify |

---

## 14. Dependency Order

```
shared types
  → core + DB (PostgreSQL, Neo4j)
    → auth + audit
      → evidence-store
        → case-platform
          → document-intelligence
            → intelligence-requirements
              → data-exchange + mock-sources
                → entity-resolution
                  → intelligence-brain
                    → graph-builder (Neo4j)
                      → analytics
                        → explainability
                          → integrity
                            → web (integrate throughout; complete last)
```

### Build Sequence

| Step | Units |
|---|---|
| 1 | `shared`, `core`, `auth`, `audit` |
| 2 | `evidence-store`, `case-platform` |
| 3 | `document-intelligence` |
| 4 | `intelligence-requirements` |
| 5 | `data-exchange`, `mock-sources` |
| 6 | `entity-resolution` |
| 7 | `intelligence-brain`, `graph-builder` |
| 8 | `analytics` |
| 9 | `explainability` |
| 10 | `integrity` |
| 11 | `web` |

---

## 15. MVP vs Extensible

### Must Implement (End-to-End MVP)

| Area | Scope |
|---|---|
| Cases | Create, assign, view, iterative state |
| Auth | Login + investigator + supervisor roles |
| Documents | PDF/text FIR upload, extract with provenance |
| Requests | Auto-suggest + manual + supervisor approve |
| Mock sources | ≥3 adapters (CDR, financial, criminal history) cross-linked |
| Resolution | Rule-based matching + human review flow |
| Graph | Neo4j derived graph, ≥5 relationship types, case-scoped |
| Analytics | Centrality, timeline overlap, ≥2 pattern rules |
| Findings | FACT/INFERENCE/SIGNAL with evidence chains |
| Ask | ≥5 grounded question types |
| Loop | Seed → request → re-analysis → new finding |
| Audit | Key actions logged, view in UI |
| Integrity | Document hash + verify in UI |
| UI | Case, Entities, Network (Cytoscape.js), Timeline, Requests, Evidence, Findings, Ask |
| Demo | Operation Crosslink fully scripted |

### Remains Extensible (Interface Only)

| Area | Future |
|---|---|
| Source adapters | Real CCTNS, CDR gateway, FinIntel |
| Auth | Govt SSO |
| Integrity ledger | Consortium blockchain |
| Entity resolution | ML scoring plugin |
| Document intelligence | Hindi OCR, scanned/image pipeline |
| RAG | Fine-tuned retrieval |
| Real-time feeds | Streaming ingestion |

---

## Document Intelligence Extensibility Note

**MVP:** PDF and plain-text FIR ingestion via `IDocumentProcessor` with LLM-assisted extraction (D3).

**Preserved boundary:** `document-intelligence` module exposes a processor abstraction supporting future:
- Scanned/image FIR (OCR pipeline plug-in)
- Hindi and multilingual documents
- Handwriting recognition

Do not over-engineer multilingual OCR in MVP; preserve interface and provenance model.

---

## Change Control

**Phase 4 implementation status (2026-09-18):** The existing `entity-resolution` boundary now implements
source normalization, type-specific candidate blocking/comparison, canonical case entities, reversible accept/reject
review, source provenance and versioned case-state summaries. It reuses Phase 1–3 auth, audit, evidence store,
source adapters, Prisma client and event bus. All 107 tests pass. This is a status mapping, not a change to the frozen
architecture or phase order. See [Phase 4 implementation and rules](PHASE-4-STATUS.md). Phase 5 has not started.

Modifications require explicit review. See [IMPLEMENTATION-DECISIONS.md](./IMPLEMENTATION-DECISIONS.md).
