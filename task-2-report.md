# Task 2 Report

## Fix Round 1 - 2026-09-05

- Dynamic supplier enrichment now chooses only the active `supplier_catalog` registry version with a parameterized `ib.registry_version = ?` predicate. The selected version comes from `getStructuredRegistry("supplier_catalog").version`, not the delivery-ledger query version.
- Added regression coverage proving a newer stale-version supplier catalog is ignored while same-version catalog tie-breaking still picks the deterministic latest batch.
- Direct domain structured-query validation now rejects `{ op: "count", field: "" }` with `invalidAggregation`, matching the MCP contract's minimum-length field behavior for direct callers.
- Verification passed:
  - `npm test -- packages/domain/src/structured-query.test.ts apps/api/src/structured-query-route.test.ts`
  - `RUN_STRUCTURED_QUERY_PRISMA_INTEGRATION=1 DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@127.0.0.1:3307/enterprise_hub' npm test -- apps/api/src/structured-query.prisma.integration.test.ts`
  - `npm run lint`
  - `npm run typecheck`
  - `npm test`
  - `npm run format:check`
  - `git diff --check`
- Local MySQL integration artifacts were cleaned with `MYSQL_PORT=3307 docker compose down -v`; follow-up checks found no `enterprise-hub` container, no task-scoped Docker volume/network residue, and no `.data` files.
