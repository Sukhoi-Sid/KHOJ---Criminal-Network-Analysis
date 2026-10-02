# SIH 26189 – Criminal

**AI-driven Investigative Intelligence System**

An intelligent investigative layer over authorized criminal-justice information — not a replacement for CCTNS/ICJS. Converts fragmented, case-scoped evidence into connected, explainable relationship and pattern intelligence for investigators.

**Organization:** NCRB, Women Safety Division, Ministry of Home Affairs, Government of India  
**Theme:** Blockchain & Cybersecurity

---

## Design Source of Truth

All architecture and implementation decisions are documented and **frozen**:

👉 **[docs/SOURCE-OF-TRUTH.md](./docs/SOURCE-OF-TRUTH.md)**

| Document | Location |
|---|---|
| System Architecture | [docs/architecture/SYSTEM-ARCHITECTURE.md](./docs/architecture/SYSTEM-ARCHITECTURE.md) |
| Architecture Decisions | [docs/architecture/ARCHITECTURE-DECISIONS.md](./docs/architecture/ARCHITECTURE-DECISIONS.md) |
| Implementation Blueprint | [docs/implementation/IMPLEMENTATION-BLUEPRINT.md](./docs/implementation/IMPLEMENTATION-BLUEPRINT.md) |
| Implementation Decisions | [docs/implementation/IMPLEMENTATION-DECISIONS.md](./docs/implementation/IMPLEMENTATION-DECISIONS.md) |

**Do not implement features that contradict these documents without an explicit design review.**

---

## Product Positioning

> An AI-driven investigative intelligence and correlation layer that transforms authorized, fragmented criminal-justice information into explainable relationship, temporal, and pattern-based intelligence for investigators.

The system supports investigators. It does not replace investigative or legal decision-making.

---

## Implementation Status

| Phase | Status |
|---|---|
| Design (Architecture + Blueprint) | ✅ Frozen |
| Phase 1 — Foundation & Secure Case System | ✅ Implemented + security-fixed — see [docs/implementation/PHASE-1-STATUS.md](./docs/implementation/PHASE-1-STATUS.md) |
| Phase 2 — FIR & Document Intelligence | Implemented and regression-tested against PostgreSQL — see [Phase 2 status](./docs/implementation/PHASE-2-STATUS.md) |
| Phase 3 — Intelligence Requirement & Data Exchange | Implemented: rule-based case context, explainable gaps, review, supervisor authorization, six synthetic adapters, audit and provenance — see [Phase 3 status and API guide](./docs/implementation/PHASE-3-STATUS.md) |
| Phase 4 — Data Integration & Entity Resolution | Implemented: normalized sources, canonical case entities, explainable matching, reversible review and provenance — see [Phase 4 guide](./docs/implementation/PHASE-4-STATUS.md) |
| Merged Phase 5+6 — Brain, Graph & Analytics | Implemented: evidence-bound relationships, Neo4j sync/rebuild, network and temporal analytics, deterministic pattern signals — see [Merged Phase 5+6 status](./docs/implementation/MERGED-PHASE-5-6-STATUS.md) |
| Phases 7–9 | Planned; not implemented |

## Run the current project

Requires Node.js 20+, pnpm, PostgreSQL and Neo4j. Compose exposes PostgreSQL on port 5433 and binds Neo4j to
loopback ports 7474/7687. Copy `.env.example` to `apps/api/.env` and configure the credentials and a local JWT secret.

```sh
pnpm install --frozen-lockfile
# If using Docker:
docker compose up -d postgres neo4j
pnpm db:generate
pnpm --filter @sih/api exec prisma migrate deploy
pnpm build
pnpm db:seed
pnpm start
```

The API listens on `http://localhost:3001`; `GET /health` checks PostgreSQL and `GET /health/graph` checks Neo4j.
The repository currently contains an API and shared contracts. The command-center frontend remains Phase 8.

```sh
pnpm typecheck
pnpm test
pnpm demo:phase3
pnpm demo:phase4
pnpm demo:merged
```

Tests create/migrate a separate database ending in `_test` and clear only its application tables.
Override `TEST_DATABASE_URL` if needed. The test setup requires an existing test database or permission to create one.
Demo data is synthetic. `db:seed` creates theft/scam gaps for review; `demo:phase3` explicitly exercises investigator review,
independent supervisor approval and exchange for both scenarios. Rerunning it reuses the same requests and packages.
The merged demo verifies scenarios A–H: centrality, bridge detection, communities, multi-hop paths,
communication and financial patterns, temporal correlation, idempotency and rebuild consistency.
The full regression suite contains 134 tests. The existing demo accounts use `Passw0rd!2026`:
`investigator@ncrb.demo` and `supervisor@ncrb.demo`.
