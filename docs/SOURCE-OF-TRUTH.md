# SIH 26189 – Criminal: Design Source of Truth

**Project:** AI-driven Investigative Intelligence System  
**Organization:** NCRB, Women Safety Division, Ministry of Home Affairs, Government of India  
**Theme:** Blockchain & Cybersecurity  
**Status:** Architecture and Implementation Blueprint **FROZEN**

---

## Purpose

This directory is the **authoritative design reference** for the project. All implementation must align with these documents. Architectural or blueprint changes require an **explicit review** — never silent drift.

---

## Frozen Documents

| Document | Path | Description |
|---|---|---|
| **System Architecture** | [architecture/SYSTEM-ARCHITECTURE.md](./architecture/SYSTEM-ARCHITECTURE.md) | Complete system architecture (9 phases, components, flows, principles) |
| **Architecture Decisions** | [architecture/ARCHITECTURE-DECISIONS.md](./architecture/ARCHITECTURE-DECISIONS.md) | Record of architectural decisions (AD-*) and assumptions |
| **Implementation Blueprint** | [implementation/IMPLEMENTATION-BLUEPRINT.md](./implementation/IMPLEMENTATION-BLUEPRINT.md) | Practical implementation plan (modules, storage, contracts, MVP scope) |
| **Implementation Decisions** | [implementation/IMPLEMENTATION-DECISIONS.md](./implementation/IMPLEMENTATION-DECISIONS.md) | Locked implementation choices (D1–D6 and related) |

---

## Core Principles (Non-Negotiable)

1. **Evidence Store is the source of truth.** Original source records and evidence are authoritative.
2. **Knowledge Graph is derived.** Analytical representation only — never authoritative truth.
3. **Investigation is iterative.** Case → Intelligence → Finding → Review → Seed → Request → Data → Re-analysis → New Finding.
4. **External data is request-mediated.** Scoped, authorized Intelligence Requests only — no unrestricted access.
5. **Everything is case-scoped and interconnected.**
6. **Findings are evidence-grounded.** Classified as FACT / INFERENCE / SIGNAL with confidence.
7. **Human investigator remains in control.** Decision support only — no guilt/criminality labels.
8. **Security, RBAC, and audit are cross-cutting** from Phase 1 onward.
9. **Blockchain is for integrity/provenance/hashing** — not raw sensitive data on-chain.
10. **MVP is a modular monolith** — clean module boundaries, not unnecessary microservices.

---

## Nine Connected Phases

| Phase | Name |
|---|---|
| 1 | Foundation & Secure Case System |
| 2 | FIR & Document Intelligence |
| 3 | Intelligence Requirement & Data Exchange |
| 4 | Data Integration & Entity Resolution |
| 5 | Intelligence Brain & Knowledge Graph |
| 6 | Network, Temporal & Pattern Intelligence |
| 7 | Explainable Intelligence & Investigative RAG |
| 8 | Investigator Command Center |
| 9 | Blockchain, Security & Final Integrity Layer |

**Build order:** Phase 1 → 9. Intelligence Brain core capability lives in Phases 5–7. Phases 2–3 may perform minimal scoped processing (extraction, gap analysis) only.

---

## Locked Implementation Choices

| ID | Decision |
|---|---|
| D1 | Neo4j for derived Knowledge Graph (MVP) |
| D2 | Monorepo with npm/pnpm workspaces |
| D3 | External LLM API for extraction/RAG, behind provider abstraction |
| D4 | Local integrity/hash ledger for MVP; blockchain boundary extensible |
| D5 | Primary demo: synthetic **Operation Crosslink** investigation |
| D6 | React + Cytoscape.js for investigator graph experience |

**Document intelligence (MVP):** PDF and text ingestion. Architecture preserves extensibility for scanned/image and Hindi documents without over-engineering multilingual OCR now.

---

## Change Control

If implementation requires a design change:

1. Identify the conflict with frozen architecture or blueprint.
2. Document the proposed change and architectural impact.
3. Obtain explicit approval before modifying frozen documents or deviating in code.

---

## Current implementation (2026-09-21)

Phases 1 and 2 were verified from the supplied ZIP against a clean PostgreSQL database: all 44 baseline tests passed.
Phase 3 extends the existing modular monolith, shared permissions, in-process event bus and evidence/provenance store.
The explicitly authorized Phase 3 addition is the configuration-driven case-type requirement engine; it does not add
entity resolution, graph analytics, RAG, blockchain or the command-center frontend.

The user-authorized Phase 4 adds case-scoped data integration and entity resolution within the existing boundary:
normalized records, canonical entities, scored candidates, reversible human decisions and provenance.

The explicitly authorized Merged Phase 5+6 implements the original Phase 5 and Phase 6 as one delivery with no
scope reduction. It adds evidence-bound persisted relationships, a derived case-scoped Neo4j graph, sync/rebuild
and consistency checks, network/path/community analytics, temporal analysis, explainable deterministic pattern
signals, analysis runs, audit and case-state events. Evidence and PostgreSQL remain authoritative. Phases 7–9
remain unimplemented. All 134 Phase 1–6 tests pass against real PostgreSQL and Neo4j.

- [Phase 1 status](implementation/PHASE-1-STATUS.md)
- [Phase 2 status](implementation/PHASE-2-STATUS.md)
- [Phase 3 implementation, API, demo and verification](implementation/PHASE-3-STATUS.md)
- [Phase 4 implementation, rules, API, demo and verification](implementation/PHASE-4-STATUS.md)
- [Merged Phase 5+6 implementation, graph, analytics, API and verification](implementation/MERGED-PHASE-5-6-STATUS.md)
- [D8 implementation decision](implementation/IMPLEMENTATION-DECISIONS.md#d8--phase-3-case-type-requirements-2026-09-17)
- [D9 merged implementation decision](implementation/IMPLEMENTATION-DECISIONS.md#d9--merged-phase-56-2026-09-21)

## Related

- [Project README](../README.md) — high-level project overview
