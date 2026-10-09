# Phase 7 — Explainable Intelligence & Investigative RAG

**Status:** Complete and verified on 2026-09-21  
**Boundary:** Retrieval, reasoning and explanation over existing Phase 1–6 intelligence; no Phase 8/9 work

## Design

`investigative-rag` is a thin orchestration module. It reuses the existing case authorization gate, PostgreSQL evidence
metadata, Phase 2 mentions, Phase 3 source permissions, Phase 4 canonical entities, Phase 5+6 persisted relationships,
Neo4j paths, network metrics, timelines and analytical signals. It does not copy those datasets or expose database tools.

Deterministic intent rules route connection, key-entity, temporal, communication, financial, location, evidence,
entity-signal, uncertainty and guilt-request questions. Exact canonical labels or up to four explicit case entity UUIDs
select entities. A request may carry one `conversation.lastEntityId`; that ID is verified against the current case and is
never persisted or reused across cases.

## Grounding and citations

Answers contain separate `facts`, `inferences`, `signals`, `citations`, `entities`, `answerQuality`, `limitations` and
`generatedAt` fields. Every substantive claim has citation IDs. Relationship citations lead to source relationship IDs
and evidence citations; evidence citations retain evidence/document/source-record IDs and page/span or JSON-pointer
locations when available. Network claims cite separate degree, betweenness, PageRank and community metadata plus
supporting relationships. Signal explanations reuse the persisted Phase 6 rule, metrics, thresholds, caution and evidence.

The provider receives only categorized claims and limitations. It cannot access Prisma, Neo4j, raw SQL/Cypher, secrets
or tools. `RAG_PROVIDER`, `RAG_MODEL` and `RAG_TIMEOUT_MS` are configurable. The default
`deterministic/grounded-template-v1` provider needs no external service. Timeout, exception or malformed output invokes
the same deterministic grounded fallback and records that limitation. LLM self-confidence is never used as probability.

## Semantic retrieval decision

No embedding model, pgvector extension or separate vector database is added. The current moderate corpus already has
structured entity, relationship, timeline, signal and page/span metadata. Deterministic retrieval is more precise and
auditable for the required questions. The provider boundary permits future case-scoped semantic retrieval if genuinely
needed without changing evidence authority or duplicating graph analytics.

## Security and privacy

Every request uses authentication, live role permissions, case assignment ABAC and all returned-source permissions.
Explicit entity IDs, conversation IDs and explanation resource IDs are looked up within the authorized case. Cross-case
IDs return no content. There is no public chatbot, raw query endpoint or arbitrary provider tool call.

Questions and retrieved documents are untrusted data. Instruction-like attempts to reveal prompts/secrets or execute
SQL/Cypher return a controlled response with no retrieved claims. Audit records store request ID, case/user, intent,
retrieval types, provider/model, status and SHA-256 question hash; raw question text is not stored. Evidence drill-down
omits blob paths, credentials, internal prompts and unnecessary transformation metadata.

Guilt requests explicitly state that the system cannot determine guilt or make law-enforcement decisions. Network
position, confidence and signals remain investigative leads requiring human and legal review. Conflicting or unresolved
identity candidates are preserved and reported as unknown rather than silently reconciled.

## APIs

- `POST /api/cases/:caseId/investigate/ask` — question plus optional `entityIds`, offset-aware `from`/`to`, and verified request-scoped conversation entity.
- `GET /api/cases/:caseId/investigate/explanations/:kind/:id` — sanitized `relationship`, `signal`, `entity` or `evidence` drill-down.

Inputs are strict and bounded: 3–1,000 question characters, at most four entity IDs, UUID-only resource identifiers and
valid chronological windows.

## Operation and validation

```sh
docker compose up -d postgres neo4j
pnpm db:seed
pnpm demo:merged
pnpm demo:phase7
pnpm typecheck
pnpm build
pnpm test
```

The Phase 7 A–G demo verifies a cited multi-hop connection, neutral key-entity explanation, incident timeline,
communication signal, exact relationship evidence, guilt refusal and cross-case denial. The full suite contains 156
Phase 1–7 tests, including provider failure/malformed fallback, prompt injection, ABAC/IDOR and audit privacy checks.

## Limitations

The default provider produces concise structured prose rather than free-form narrative generation. Entity-name matching
uses exact normalized labels; clients should pass canonical IDs when labels are ambiguous. Paths and metrics require a
current Neo4j projection, while persisted evidence relationships and signals remain available as a controlled fallback.
No frontend, autonomous action, guilt/risk scoring, Phase 9 anchoring or cross-case conversation memory is included.
