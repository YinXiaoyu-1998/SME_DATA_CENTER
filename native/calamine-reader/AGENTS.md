# Rust XLSX reader

- Implements the protocol consumed by `packages/structured-ingestion/src/calamine-reader.ts`; read `packages/structured-ingestion/AGENTS.md` when changing either side.
- Emit only bounded newline-delimited JSON events on stdout: sheet, row batches, end-sheet, completion. Diagnostics go to stderr; failures exit nonzero without pretending completion.
- Preserve worksheet metadata/order, monotonic source row numbers and cell text semantics. Keep archive/sheet/cell limits and batch flushing; do not add heuristic dataset repair.
- Reflect dependency changes in `Cargo.lock`. Build from the root with `npm run build:calamine-reader`; validate with the real-reader fixture command in `packages/structured-ingestion/AGENTS.md`.
- Binary packaging changes also read `deploy/AGENTS.md` and `.github/AGENTS.md`; the worker image must contain the executable consumed by the TypeScript adapter.
