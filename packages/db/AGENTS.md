# Prisma and persistence

- Schema/config: `packages/db/prisma/schema.prisma`, `packages/db/prisma.config.ts`. Add migrations for schema changes; preserve already-applied migration history.
- Commands: `npm run db:generate`, `npm run db:migrate`, `npm run db:seed`. Before reset, migration execution or service setup read `scripts/AGENTS.md`; remote deployment follows `deploy/AGENTS.md`.
- Authorization SQL must match `packages/domain/AGENTS.md`: bind values, allow only registered identifiers, preserve exact comparisons and apply scope before aggregation/pagination.
- Keep version checks, authorization mutation and audit records transactional. Preserve publication locks and atomic resource/catalog updates; storage cleanup must not delete current published objects.
- Reuse `createDatabaseAdapter` and its shared-pool lifecycle. Preserve the text-protocol workaround for the RDS proxy; adapter changes need existing pool/protocol integration tests.
- Focused checks: `npm test -- packages/db/src`; persistence claims require relevant real-MySQL coverage, not only repository mocks.
