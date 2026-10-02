# Phase 4 — Data Integration & Entity Resolution

Implemented in the existing verified Phase 3 workspace. This extends the frozen modular monolith's
`entity-resolution` boundary; the graph and all Phase 5+ functionality remain unimplemented.

## Implementation and reuse

The module contains source integration, a value-normalizer registry, six returned-data category normalizers,
entity-specific blocking/comparison strategies, constrained canonical grouping, review/history, events and routes.
It reads persisted Phase 2 mentions and cached page spans, approved Phase 3 returned packages through the existing
hash-verifying evidence store, and the case reference. It does not run a second extraction pipeline.

Existing JWT authentication, shared role permissions, assignment ABAC, audit service, Prisma client, source adapters,
evidence/provenance records and event bus are reused. Live role/source policy helpers now serve both Phase 3 and 4.
Phone/vehicle formatting and JSON hashing/serialization helpers are shared rather than reimplemented.
Case platform remains the sole writer of `CaseIntelligenceState`; completion events update its versioned resolution
section while preserving the document summary. Delivery retry and sequence checks prevent duplicate state changes.

## Normalization and matching

Original spelling, source attributes, confidence, reliability tier and timestamps remain on immutable source snapshots.
Normalization is formatting, not a finding of identity. Shared `MentionType` is reused: `money` represents financial
identifiers only in this module; currency amounts are excluded from mention integration. Dates support person attributes.

| Type | Formatting and resolution |
|---|---|
| Person | NFC, whitespace and lowercase; initials/token compatibility and bounded edit similarity; names alone never auto merge |
| Phone | Indian 10-digit, +91, 0091 and trunk-zero variants; explicit other international numbers preserved; placeholders invalid |
| Vehicle | Uppercase; spaces/hyphens removed only for a valid registration pattern |
| Account/payment identifier | Leading zeros retained; numeric spacing removed; UPI punctuation/case retained; conflicting bank namespaces block merging |
| Organization/location | Conservative text normalization; exact/fuzzy text still requires review |
| Case identifier | Case/whitespace formatting; exact normalized identifiers |

`RESOLUTION_RULES` in `resolvers.ts` centralizes thresholds and version `phase4-v1`:

| Evidence | Score / result |
|---|---|
| Exact valid identifier or matching explicit government identifier | 0.99 / automatic if no conflict |
| Shared phone + compatible person name (similarity >= 0.55) | 0.94 / automatic if no conflict |
| Shared DOB + address + name similarity >= 0.80 | 0.92 / automatic if no conflict |
| Name alone | 0.55 × similarity / review; never automatic |
| Phone alone on different person names | 0.65 / review |
| Conflicting supplied identifiers/attributes | 0.10 / DISTINCT, no merge |

Automatic threshold is 0.90; ordinary review threshold is 0.45. Compatible person names also enter review below
that score, including initials (similarity 0.75). Organization/location text requires similarity >= 0.80 for a candidate.
Scores are deterministic rule scores, not probabilities. Source transcription confidence is recorded separately.
Missing attributes are not fabricated. Person attributes from FIRs are associated only within an explicit labeled
subject block of contiguous Phone/DOB/Address/Account/Vehicle/Organization lines using existing mention spans.

Blocking uses entity type, normalized identifiers, names/initials and conservative text prefixes. No global all-pairs
comparison is performed. Limits are 2,000 active source records and 50,000 blocked pairs per case; exceeding a limit
fails the transaction explicitly. Group-level checks prevent transitive paths from bypassing conflicts or rejected pairs.

## Database, provenance and reversible review

Migration `20260917182413_phase4_entity_resolution` adds `NormalizedSourceRecord`, `CanonicalEntity`,
`EntitySourceLink`, `ResolutionCandidate`, `ResolutionHistory`, source/status enums and existing audit enum values.
Unique source keys, pair keys and membership keys prevent duplicates. Composite case-scoped foreign keys prevent
cross-case entity links/candidates/history; score ranges, valid entity types, pair ordering and positive revisions are checked.

Every canonical entity links to all contributing normalized records. Mention records retain original mention ID,
page/character spans, document/evidence references and content hash. Returned records retain department/source,
request/response IDs, JSON pointer, original row, retrieval timestamp and existing EvidenceRecord/Provenance chain.
Case metadata records explicitly identify `case.caseId`. Nothing is silently upgraded to verified evidence.

Review records actor, timestamp, reason, previous/new state, score/signals/conflicts and revision. An idempotency UUID
replays the same decision; changed payload/key reuse and stale revisions fail. Reversing accept to reject splits derived
groups and preserves historical groups, links and decisions. Reversing a rejection can be reviewed again; contradictory
source identifiers cannot be overridden by clicking accept. Unchanged same-state decisions require retrying the original key.
Retired source records remain inspectable through historical entities/candidates, and changed inputs require reintegration.
Force-replacing Phase 2 mentions rebinds their FK without recreating stable source/canonical identities.

Case locks serialize integration/review. Audit persistence and domain changes commit together. Durable history drives
the existing event bus and retries unfinished delivery on the next integration/review. No new queue/event bus is added.

## API

All routes below use `/api/cases/:caseId/resolution` and a bearer token:

| Method | Suffix | Purpose |
|---|---|---|
| POST | `/integrate` | Normalize current sources, resolve and update case state; body `{}` |
| GET | `/entities?status=REVIEW_REQUIRED` | Current entities; optional resolution status |
| GET | `/entities/:entityId` | Entity sources, provenance and related candidate history, including historical groups |
| GET | `/records` | Current normalized records with evidence provenance |
| GET | `/candidates?status=REVIEW_REQUIRED` | Candidates with scores, signals, conflicts and source records |
| GET | `/candidates/:candidateId` | Candidate evidence and decision history |
| POST | `/candidates/:candidateId/review` | Accept/reject using body below |
| GET | `/history` | Ordered case resolution event/decision history |

```json
{
  "decision": "accept",
  "reason": "Compared the contributing documents and supporting identifiers.",
  "expectedRevision": 1,
  "idempotencyKey": "use-a-new-UUID-for-this-decision"
}
```

`entity:read` and `entity:resolve` are limited to assigned investigators/supervisors. Admin/auditor roles cannot read
derived case content. Live role checks invalidate stale-role JWT privileges. Missing/unassigned cases are masked as 404;
cross-case entity and candidate IDs cannot be used for reads or reviews. If any contributing returned source permission
is unavailable, the entire derived view fails closed, preventing merged-member leakage. Reads/actions are audited.

## Demo and verification

Run `pnpm db:seed`, `pnpm demo:phase3`, then `pnpm demo:phase4`. The last command integrates existing theft/scam
cases and adds only the missing fictional identity examples under `REF-2026-DEMO-RESOLUTION`. It uses existing
investigator review, independent supervisor approval and dispatch. Demo-only receipt enrichment is scoped to the demo
process; no production adapter or authorization bypass is added.

Verified on 2026-09-18:

- A: Rahul Sharma / CDR subscriber Rahul S. with formatted same phone resolve automatically.
- B: Amit Kumar / criminal-history Amit Kumar without identifiers requires review.
- C: Rahul records with different phones, DOBs and addresses remain distinct with explanations.
- D: MP04AB1234 and MP-04-AB-1234 resolve to the same vehicle group.
- E: A second run leaves 12 canonical entities, 16 source links and 8 candidates unchanged (16 source records).
- All 107 tests pass: 31 Phase 1, 13 Phase 2, 35 Phase 3 and 28 Phase 4. Tests use isolated PostgreSQL.
- Phase 4 covers normalization, strong/multiple/fuzzy/no-match rules, transitive conflicts, package provenance,
  accept/reject/reversal/history, concurrent integration, audit rollback, retired sources, force-reprocessing,
  stale-context review, source permissions, admin/auditor restrictions, assignment ABAC, entity/candidate IDOR and event replay.
- Schema validation, Prisma generation, development/test migrations, seed, typecheck, build and installed dependencies pass.
- Live API on port 3001 returns `/health` status `ok` with database `connected`. Authenticated integration returns
  `reused: true`; entity listing returns 12 entities and review filtering returns one pending candidate.

Phase 4 completion: **100% of the requested Phase 4 scope**, with the MVP limits below. Phases 1–3 remain included.

The architecture/duplication audit found one application Prisma client, event bus, audit service, source-adapter registry,
case-access primitive and resolution service. Test database setup and unhealthy-DB tests intentionally use separate clients.
Prisma persistence enums mirror the existing shared contract; no competing entity taxonomy was introduced.

## Limits

Deterministic MVP rules support the supplied English/Indian identifier formats. Fuzzy blocking can miss unrelated
spellings; unmatched records remain unresolved. Contradictory attributes are treated conservatively, including phone
changes and address changes. No real departmental connectors, probabilistic model, global person registry, graph,
analytics, RAG, blockchain or frontend is included. Reintegrate after source changes; event retry occurs on an integration
or review call rather than a background worker. No frozen architecture deviation was required.
