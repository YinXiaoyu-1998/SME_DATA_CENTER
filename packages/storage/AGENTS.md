# Object storage

- Keep local and OSS behavior behind `StorageAdapter`; align size/hash, missing-object and stream semantics across adapters.
- Validate relative object keys and tenant/document segments before filesystem or OSS operations. Preserve path-traversal defenses; provider keys and user-visible filenames are distinct.
- Multipart support retains checksum/size verification and abort cleanup. Never log signed URLs or credentials, or turn arbitrary caller paths into storage keys.
- The calling service authorizes before URL issuance; an object key is not permission. Public source-download contracts remain distinct from internal partition transfer URLs.
- Focused checks: `npm test -- packages/storage/src`. `npm run test:storage:oss` is a real-provider check governed by `scripts/AGENTS.md`; clean up only run-owned objects.
