# Structured ingestion

- Stream CSV/XLSX processing with bounded rows, cells, archive expansion, buffers and open files. Preserve preflight checks, abort propagation and scratch cleanup; do not load whole large workbooks to simplify a transform.
- Dataset schemas/header aliases come from `packages/domain/src/structured-registry.ts`. Reject invalid input with established errors; do not silently repair business data or invent missing scope/date fields.
- Preserve canonical partition headers/order, exact store/day routing, row counts, byte sizes and SHA-256 checksums. Partition model: `docs/adr/0026-business-dishes-current-oss-partitions.md`; publication: `apps/worker/AGENTS.md`.
- Validate Calamine event order, sheet metadata, row numbers, size limits, completion and exit status. Protocol changes also read `native/calamine-reader/AGENTS.md`.
- Focused checks: `npm test -- packages/structured-ingestion/src`. Real-reader checks: `npm run build:calamine-reader`, set `SMEDC_CALAMINE_READER_PATH` to the built binary, then `RUN_CALAMINE_INTEGRATION=1 npm test -- packages/structured-ingestion/src/partition-export.test.ts`.
