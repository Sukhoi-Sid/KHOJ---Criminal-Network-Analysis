# Merged Phase 5+6 — Implementation Status

**Status:** Complete and verified on 2026-09-21  
**Scope:** Original Phase 5 and Phase 6 combined with no scope reduction  
**Boundary:** Phase 7–9 are not implemented

## Pipeline and authority

The existing Phase 1–4 modular monolith is preserved. The implemented flow is:

`Evidence / returned packages → canonical entities → persisted relationships → Neo4j sync → network and temporal analytics → structured signals → case intelligence state`

Original evidence and PostgreSQL metadata remain authoritative. Neo4j stores a case-scoped, rebuildable analytical
projection. It contains stable entity and relationship identifiers plus graph-relevant properties; it does not become
an evidence store. A failed graph operation records failure state while leaving evidence and PostgreSQL relationships intact.

## Relationship model

Relationship extraction consumes verified Phase 2 document mentions, Phase 3 returned packages and active Phase 4
canonical links. Original document and package hashes are checked before derived state is trusted. Structured source
rows are grouped by their source record, so mere co-mention never creates an edge.

Supported persisted relationship types are `ASSOCIATED_WITH_PHONE`, `ASSOCIATED_WITH_VEHICLE`, `OWNS`,
`ASSOCIATED_WITH_ACCOUNT`, `ASSOCIATED_WITH`, `WORKS_FOR`, `MEMBER_OF`, `SEEN_AT`, `VISITED`, `MENTIONED_IN`,
`CALLED`, `COMMUNICATED_WITH`, and `TRANSFERRED_TO`. Each relationship has stable case/source/target/type identity,
direction, FACT/INFERENCE classification, confidence and strength, source system and record IDs, evidence references,
source time fields, extraction/version metadata, attributes and active state. Confidence describes source support; it is
never a guilt probability. Unsupported or ambiguous source data creates no relationship.

## Graph synchronization

One lazy Neo4j driver owns graph access. Nodes use stable namespaced keys derived from case ID and canonical entity ID.
Edges use persisted relationship IDs and preserve physical direction. All Cypher is parameterized and case-scoped.

Initial and incremental sync use idempotent `MERGE`; obsolete projection entries are pruned. Case rebuild deletes only
that case's projection and recreates it from PostgreSQL inside a Neo4j transaction. Consistency checks detect missing,
extra or duplicate nodes and edges, wrong node types, and wrong relationship endpoints/types. Sync repairs incorrect
topology and records `SYNCING`, `SYNCED` or `FAILED` state plus source and graph digests.

## Analytics and limits

The application computes separate degree, normalized Brandes betweenness and PageRank metrics. It does not combine
them into a person or criminal score. Deterministic local modularity optimization supplies community detection when
Neo4j GDS is unavailable. Stable community IDs derive from community membership.

Shortest and bounded multi-hop paths use a simple undirected analytical projection while returned relationships retain
their source direction and evidence. Neighborhood and path queries verify entity membership and are bounded to four
hops and 200 results. Graph processing is bounded to 2,000 nodes and 10,000 relationships per case.

The timeline orders `occurredAt` then `observedAt`, puts unknown times last, and supports entity, relationship type and
offset-aware time filters. Activity buckets, bursts and temporal proximity never claim causality.

## Pattern rules

All rules are versioned as `merged-5-6-v1` and thresholds live in one registry. Current defaults include a one-hour
activity window, 15-minute proximity, three-event burst minimum, 3× communication spike ratio, four-record financial
baseline, 1.5× IQR outlier factor, fan threshold three, high degree four, normalized bridge betweenness 0.1, and two
repeated location overlaps.

Communication rules cover spikes, repeated short-window contact, reciprocity, new-target bursts, incident-window
concentration and cross-community contact. Financial rules cover IQR-relative outliers, bursts, repeated transfers,
fan-in/fan-out, rapid chains, circular flow and incident-window activity. Location rules cover multi-entity overlap,
repeated overlap, chains, rare-location association and incident windows. Cross-source correlation requires an explicit
shared entity or evidence-supported association and multiple source categories in the proximity window.

Every persisted signal is typed `SIGNAL` and contains involved entity IDs, strength/confidence, time window, rule and
algorithm version, parameters and thresholds, structured reason/metrics/caution, supporting relationship IDs and
evidence references. Stable keys make reruns idempotent; stale signals retire and may reactivate when the same supported
state returns. Signals remain investigative leads, not evidence or legal conclusions.

## Storage and runs

Migration `20260920190130_merged_phase5_6` adds `DerivedRelationship`, `GraphSyncState`, `AnalysisRun`,
`AnalyticalSignal`, `SignalSupport`, and durable `BrainEvent` records with case-scoped foreign keys, uniqueness,
indexes and confidence/classification constraints. Runs track type, input digest, version, parameters, status, timing,
summary and sanitized error. Completion events update the existing versioned `CaseIntelligenceState` idempotently.

## API

All routes are below `/api/cases/:caseId/brain` and use existing authentication, live role permissions and case assignment ABAC.

- Execution: `POST /run`, `/graph/sync`, `/graph/rebuild`, `/network/run`, `/patterns/run`
- Graph: `GET /graph/status`, `/graph`, `/graph/neighborhood/:entityId`, `/graph/paths`
- Network: `GET /network`, `/network/centrality`, `/network/communities`, `/network/key-entities`
- Temporal: `GET /timeline`
- Signals and auditability: `GET /signals`, `/signals/:signalId`, `/runs`

Pagination, depth, time and result bounds are validated. There is no raw Cypher endpoint. Cross-case entity, path and
signal identifiers return no data. Investigator and assigned-supervisor permissions follow the existing source access
rules; existing administrator and auditor case-content restrictions are preserved. Graph sync/rebuild, analytical runs
and derived reads use the existing audit service. Durable domain events retry subscriber failures without duplicating state.

## Infrastructure and operation

Docker Compose supplies PostgreSQL 16 and Neo4j 5.26 Community. Neo4j is bound to loopback ports 7474/7687 and uses
the `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, and `NEO4J_DATABASE` settings. Start and verify with:

```sh
docker compose up -d postgres neo4j
pnpm db:generate
pnpm --filter @sih/api exec prisma validate
pnpm --filter @sih/api exec prisma migrate deploy
pnpm db:seed
pnpm typecheck
pnpm build
pnpm test
pnpm demo:merged
pnpm start
```

`GET /health` verifies PostgreSQL and `GET /health/graph` verifies Neo4j without exposing credentials. Tests use a
separate `_test` PostgreSQL database and a separate Neo4j namespace. On Windows/Node 24 the test command runs each
file in a fresh VM-thread process to avoid a runtime worker-termination issue while executing every assertion.

## Verification

- All 134 Phase 1–6 tests pass: 107 retained Phase 1–4 tests plus 27 merged-phase algorithm/workflow tests.
- Tests use real PostgreSQL and real Neo4j for sync, corruption/repair, rebuild, outage, case isolation and IDOR checks.
- The complete A–H Operation Crosslink demo passes: key entity, bridge, communities, bounded multi-hop path,
  communication spike, financial pattern, temporal cross-source correlation and stable rerun/rebuild.
- The verified demo produced 35 nodes, 19 communities, 63 active signals and a three-hop indirect path.
- Prisma generation, validation, migration status, seed, typecheck, build, API startup and both health endpoints are
  part of final delivery validation.

## Known limits

The MVP uses deterministic extraction for supported structured or explicitly labeled data; it does not infer unsupported
relationships from narrative text. Community detection is an application-level local-modularity fallback rather than
Neo4j GDS Louvain. Analytics intentionally reject cases above configured bounds. Pattern baselines are case-local and
descriptive. Phase 7 RAG/narrative explanation, Phase 8 frontend and Phase 9 blockchain/integrity ledger are outside this delivery.

Neo4j JavaScript driver usage follows the official [installation](https://neo4j.com/docs/javascript-manual/current/install/)
and [transaction](https://neo4j.com/docs/javascript-manual/current/transactions/) guidance.
