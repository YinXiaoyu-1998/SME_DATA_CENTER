# Background processing

- Processing runs use worker ownership, attempt numbers and expiring leases. Keep heartbeats active and fence terminal/publication writes against the current lease; a stale worker must not publish or complete another attempt.
- Preserve separate claim/heartbeat/terminal ownership for partition download jobs. Retry only classified retryable failures; keep terminal error codes safe for callers.
- Partition imports upload and verify candidates before atomic catalog publication. Preserve old published data on failure and cleanup/garbage collection for abandoned objects and scratch files. Related rules: `packages/db/AGENTS.md`, `packages/structured-ingestion/AGENTS.md`.
- Evidence indexing keeps retrieval configuration/version metadata aligned with persisted chunks and Qdrant payloads. Shared contracts: `packages/domain/AGENTS.md`.
- Ledger generation/bundling follow `packages/ledger-archive/AGENTS.md` and `docs/implementation/ledger-pdf-operations.md`; preserve scheduled reconciliation and distinguish ZIP preparation from PDF generation.
- Focused checks: `npm test -- apps/worker/src`; narrow to the changed processor. Real renderer/provider/runtime verification uses `scripts/AGENTS.md`.
