# Ledger PDF archive

- Read `docs/implementation/ledger-pdf-operations.md` and the PDF/source-conversion sections of `docs/implementation/business-related-authorization-design.md`.
- Preserve exact organization/store/date partition identity, object-key escaping and byte limits. Receipt IDs are business linkage keys, not document IDs.
- Publication validates the current lease, generation/data revision and source fingerprint in the publication transaction. Failed/stale candidates use storage-garbage cleanup.
- PDF read authorization uses its own category and exact store scope; source conversion preserves its registered mapping and fails closed for unsupported required dimensions.
- Photo content replacement/withdrawal invalidates affected PDFs for scheduled regeneration. Permission-only photo changes do not reclassify or invalidate PDFs; content and authorization versions are distinct.
- Employee delivery is PDF coverage/preparation/status/download; do not reopen raw ledger rows, source downloads or aggregate queries through that surface.
- Focused checks: `npm test -- packages/ledger-archive/src`; publication/render changes also cover affected `apps/worker/src/ledger-pdf` tests.
