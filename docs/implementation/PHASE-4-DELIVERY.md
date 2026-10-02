# Complete Phase 1–4 source archive

`SIH_26189_Criminal_Phase4.zip` contains the complete current project: Phase 1–4 application and shared sources,
all four ordered database migrations, all tests, synthetic seed/demo fixtures, dependency lockfile, environment example,
Docker Compose configuration, frozen architecture documents and implementation guides.

Extract into a writable folder. Use Node.js 20+, pnpm and PostgreSQL, following the root README:

```sh
pnpm install --frozen-lockfile
# Copy .env.example to apps/api/.env and configure the database/JWT secret.
# Optional local PostgreSQL: docker compose up -d postgres
pnpm db:generate
pnpm --filter @sih/api exec prisma migrate deploy
pnpm build
pnpm db:seed
pnpm demo:phase3
pnpm demo:phase4
pnpm start
```

Run `pnpm typecheck` and `pnpm test` for verification. The test runner uses a separate database ending in `_test`.
See [Phase 4 guide](PHASE-4-STATUS.md) for endpoints, rules, review workflow, provenance, security and limitations.

The archive deliberately excludes `.env` secrets, `node_modules`, package caches, generated build output, uploaded/runtime
storage, database contents, `.git`, logs and older ZIPs. Synthetic evidence and demo state are recreated by the commands
above. This is a complete source delivery, not a backup of local credentials or the running database.

Phase 5+ remains outside this delivery. No frontend is required for Phase 4; its investigation workflow is exposed through
the authenticated API.
