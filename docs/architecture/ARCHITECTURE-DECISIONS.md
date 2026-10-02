# Architecture Decisions

**Status:** FROZEN  
**Related:** [SYSTEM-ARCHITECTURE.md](./SYSTEM-ARCHITECTURE.md)

---

## Active Architectural Decisions

| ID | Decision | Status |
|---|---|---|
| **AD-01** | Case is the root isolation boundary for all intelligence | Approved |
| **AD-02** | Intelligence Brain is a pipeline orchestrator, not a monolithic ML model; **full orchestrator from Phase 5 only**; Phases 2–3 use lightweight upstream logic | Approved |
| **AD-03** | External data enters only via approved Intelligence Requests | Approved |
| **AD-04** | Knowledge Graph (Neo4j) is a **derived analytical view** over evidence — not authoritative; subordinate to Evidence Store | Approved |
| **AD-05** | LLM used for extraction/explanation; Evidence Store is source of truth | Approved |
| **AD-06** | Entity merges require confidence thresholds; ambiguous merges need human review | Approved |
| **AD-07** | Findings are typed: FACT / INFERENCE / SIGNAL | Approved |
| **AD-08** | Blockchain/integrity layer stores hashes only — no raw sensitive data on-chain | Approved |
| **AD-09** | Command Center is presentation; no duplicated business logic | Approved |
| **AD-10** | All components emit audit events for security-relevant actions | Approved |
| **AD-BUILD** | Build order follows Phases 1→9; Brain core in Phases 5–7 | Approved |
| **AD-SOT** | Evidence Store = sole source of truth; graph = derived | Approved |
| **AD-FLOW** | Explicit iterative investigation loop (Finding → Review → Seed → Request → Re-analysis) | Approved |
| **AD-DEPLOY** | Modular monolith for MVP; logical boundaries + interfaces; split services only when justified | Approved |

---

## Assumptions

| ID | Assumption |
|---|---|
| **AS-01** | Prototype uses mock departmental adapters with realistic schemas |
| **AS-02** | Investigators are authenticated government users (simulated in MVP) |
| **AS-03** | Initial cases start from FIR or seed entities provided by investigator |
| **AS-04** | Network/graph size per case is moderate (thousands of nodes) |
| **AS-05** | English document support in MVP; Hindi/scanned extensibility preserved at document-intelligence boundary |
| **AS-06** | Human approval available for intelligence requests in MVP workflow |

---

## Decision Change Log

| Date | ID | Change |
|---|---|---|
| 2026-09 | AD-BUILD | Build order aligned to Phases 1→9; Brain not deployed early as full orchestrator |
| 2026-09 | AD-SOT | Evidence Store explicitly designated sole source of truth |
| 2026-09 | AD-FLOW | Linear pipeline replaced with explicit iterative loop |
| 2026-09 | AD-DEPLOY | Microservices-by-default replaced with modular monolith for MVP |
| 2026-09 | AD-04 | Graph clarified as derived analytical representation, not authoritative |
| 2026-09 | AD-BUILD | Approved Phase 5 and Phase 6 delivered together with full original scope; Phase 7 remains separate |

---

## Change Control Process

1. Identify conflict with frozen architecture
2. Document proposed change and impact on components, data flows, security
3. Obtain explicit approval
4. Update this log and SYSTEM-ARCHITECTURE.md together
5. Never silently drift in implementation
