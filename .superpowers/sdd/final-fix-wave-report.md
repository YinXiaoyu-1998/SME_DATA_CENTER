# Final Hardening Fix Wave Report

## Findings fixed

- Release artifacts now externalize every bare third-party package import while continuing to
  bundle internal `@enterprise-hub/*` workspaces. The API artifact used by Docker starts and serves
  `/healthz` from a clean temporary application layout; worker, readiness, and staging-smoke
  artifacts import there without CommonJS dynamic-require crashes.
- The real local integration harness now generates and queries persisted provenance for direct
  HTTP, trusted one-hop HTTP, MCP outer delegation, forged-proof fallback, browser login, OAuth
  token/invalid-refresh/revoke, and operator/system-null origins. Its run-scoped fixture indexes at
  least one Qdrant-backed chunk and verifies DB, local storage, and Qdrant cleanup in `finally`.
- API contract wording now distinguishes observational provenance storage from the unchanged OAuth
  minimum-launcher-version compatibility gate.

## Tests added

- `scripts/release-build.test.ts` copies all four compiled entrypoints into a clean temporary app
  layout, imports the three guarded entrypoints, and starts the compiled API through `/healthz`.
  Before the build fix, the new test failed on bundled MariaDB with `Dynamic require of "events" is
not supported` (the same defect class as the reviewed Fastify/busboy crash).
- `scripts/test-integration.ts` adds persisted `AuditLog` and `AuthSecurityEvent` assertions for the
  complete origin matrix, explicit forged-proof fallback, and verified run-scoped cleanup.

## Commands and results

- `npx vitest run scripts/release-build.test.ts`: RED on bundled CommonJS dynamic require, then
  GREEN after third-party externalization and guarded staging-smoke import.
- Real-provider `MYSQL_PORT=3307 npm run test:integration`: PASS with OpenAI-compatible embeddings,
  DashScope rerank, the full provenance matrix, one indexed cleanup fixture, and zero asserted
  run-scoped DB/storage/Qdrant residue. The first attempt stopped at Prisma's AI reset guard; the
  rerun used the user's exact local-only consent text against Docker MySQL on `localhost:3307`.
- `MYSQL_PORT=3307 npm run test:mcp`: PASS.
- `npm test`: PASS, 66 files passed / 2 skipped; 475 tests passed / 13 skipped.
  One intermediate combined run hit the existing deploy-rollback test's 5-second timeout; that file
  passed immediately in isolation and the subsequent full-suite rerun passed.
- `npm run lint`, `npm run typecheck`, and `git diff --check`: PASS.
- `npm run format:check`: repository-wide check still reports only pre-existing SDD brief/report
  files plus the historical progress log; focused formatting for this fix wave passes.

## Remaining limitations

- No full Docker image build/container launch or live Trivy scan was repeated. The bounded
  clean-layout artifact smoke starts the exact compiled API entrypoint and catches the reviewed
  crash class; existing image-build evidence remains separate.
- No staging state or real customer data was read or changed.

## Self-review

- Scope is limited to the three final findings. No public route, MCP schema, authorization rule,
  OAuth grant, database schema, dependency version, or standalone skill behavior changed.
- Cleanup discovers persisted fixture records before deletion, deletes Qdrant points before DB
  rows, removes storage objects and auth/session artifacts, and independently recounts every
  run-scoped boundary before the harness may pass.
