# Implementation Decisions

**Status:** FROZEN  
**Related:** [IMPLEMENTATION-BLUEPRINT.md](./IMPLEMENTATION-BLUEPRINT.md)

---

## Locked Implementation Decisions

| ID | Decision | Detail | Status |
|---|---|---|---|
| **D1** | Graph database | **Neo4j** for derived Knowledge Graph in MVP | Locked |
| **D2** | Repository structure | **Monorepo** with npm/pnpm workspaces | Locked |
| **D3** | LLM integration | **External LLM API** for extraction and RAG, behind **`ILLMProvider` abstraction** | Locked |
| **D4** | Integrity / blockchain MVP | **Local integrity/hash ledger** (PostgreSQL table + verify API); blockchain boundary extensible for production | Locked |
| **D5** | Primary demo scenario | One complete scripted **Operation Crosslink** investigation | Locked |
| **D6** | Frontend graph | **React** with **Cytoscape.js** for investigator network experience | Locked |
| **D7** | Document ingestion MVP | **PDF and text** FIR ingestion; document-intelligence boundary **extensible** for scanned/image and Hindi without multilingual OCR over-engineering now | Locked |

---

## Storage Decisions (Derived from D1, D4)

| Store | Choice | Role |
|---|---|---|
| PostgreSQL | Primary operational DB | Cases, users, requests, entities, findings, audit, integrity metadata |
| Neo4j | Derived graph (D1) | Case-scoped analytical graph — rebuildable from evidence |
| Blob storage | Filesystem or S3-compatible | Raw documents and external packages |
| pgvector (optional) | PostgreSQL extension | RAG embeddings |
| Local hash ledger (D4) | PostgreSQL `integrity_anchors` | MVP tamper-evident anchoring |

---

## Deployment Decision

| Aspect | MVP | Future |
|---|---|---|
| Backend | Single modular monolith (`apps/api`) | Optional split of Gateway or Brain if scale demands |
| Frontend | Single SPA (`apps/web`) | Mobile/field app against same API |
| Services | In-process module boundaries + domain events | Same interfaces → separate deployables |

---

## LLM Provider Abstraction (D3)

```
ILLMProvider
  ├── extractEntities(documentContent, context): ExtractionResult
  ├── extractEvents(documentContent, context): EventExtractionResult
  └── generateGroundedAnswer(question, retrievalContext): GroundedAnswer
```

Implementations: swappable (e.g. OpenAI, Gemini). All outputs require provenance binding before entering evidence/graph pipeline.

---

## Document Intelligence Abstraction (D7)

```
IDocumentProcessor
  ├── supportedMimeTypes: string[]     // MVP: application/pdf, text/plain
  ├── ingest(file, caseId): DocumentRef
  └── extract(documentRef): ExtractionResult
```

Future implementations plug in without changing case platform or brain:
- `PdfTextProcessor` (MVP)
- `OcrImageProcessor` (future — scanned FIR)
- `MultilingualProcessor` (future — Hindi)

---

## Decision Change Log

| Date | ID | Change |
|---|---|---|
| 2026-09 | D1 | Neo4j selected over PostgreSQL-only graph tables |
| 2026-09 | D2–D6 | Blueprint decisions locked at freeze |
| 2026-09 | D7 | PDF/text MVP with extensible document boundary clarified |
| 2026-09 | D9 | Original Phase 5 and Phase 6 approved as one combined delivery with no scope reduction |

---

## D8 — Phase 3 case-type requirements (2026-09-17)

Explicitly authorized by the Phase 3 task. Preserve the frozen modular-monolith boundaries and add a deterministic,
configuration-driven registry in `intelligence-requirements/registry.ts`. Case types, source mappings, target constraints,
scope limits, purposes and priorities live in the registry; the core engine has no case-type branches.

Reuse Phase 2 extracted mentions and cached pages, Phase 1 RBAC/assignment ABAC, the existing event bus,
audit service and evidence-store. A gap is derived context, not evidence or permission to fetch data.
Only an independent, assigned supervisor can authorize a reviewed request. Mock data remains off-chain,
marked synthetic and tier4/unverified. The user-approved lifecycle refinement and API are documented in
[Phase 3 status](PHASE-3-STATUS.md); this leaves Phases 4–9 untouched.

## D9 — Merged Phase 5+6 (2026-09-21)

The original Phase 5 and Phase 6 are implemented as one combined **Merged Phase 5+6** with no scope reduction.
This preserves the frozen pipeline and modular-monolith deployment: evidence and PostgreSQL are authoritative;
Neo4j is a derived, rebuildable analytical view. The implementation reuses Phase 1–4 canonical entities, auth,
case ABAC, audit, provenance, domain events and case intelligence state. Application-level graph algorithms provide
the documented fallback when Neo4j GDS is unavailable. This decision does not authorize or begin Phase 7–9.

## Change control procedure

1. Identify conflict with frozen blueprint or architecture
2. Document impact on modules, storage, interfaces, MVP scope
3. Obtain explicit approval
4. Update this log and IMPLEMENTATION-BLUEPRINT.md together
5. Never silently drift in implementation
