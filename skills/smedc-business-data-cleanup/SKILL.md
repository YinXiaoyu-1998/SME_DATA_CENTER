---
name: smedc-business-data-cleanup
description: Use when the user asks to inspect, purge, clear, or clean SMEDC business data for a specific organization or employee, especially staging data cleanup, while preserving accounts, credentials, auth sessions, labels, skills, and security records.
---

# SMEDC Business Data Cleanup

Clean SMEDC business data only after the user explicitly asks for that target
organization or employee. Treat staging cleanup as a destructive operator action: identify the
exact org/user scope, run a read-only inventory first, report the categories that would be removed
and preserved, then execute only within that confirmed scope.

## Scope

Business data includes uploaded source documents, evidence chunks and Qdrant points, document
indexes, processing runs, import batches, import-window claims, partition import jobs
(`partition_import_jobs`), published structured partitions (`structured_partitions`), deferred
object cleanup records (`storage_garbage`), row-backed datasets (`vip_rows`, `dish_catalog_rows`,
`delivery_ledger_rows`, `supplier_catalog_rows`), quarantine certificates, document-label links,
and business audit logs for document/import/quarantine actions. Business and dishes datasets live
in structured partitions, not legacy row tables.

The object inventory must include every exact database-recorded key: source document
`storageObjectKey`, partition-job `temporaryObjectKey` temporary source objects, structured-partition
`objectKey` derived partition objects, and storage-garbage `objectKey` cleanup targets. Never infer
keys from filenames or delete a broad prefix in place of this inventory.

Preserve identity and configuration data unless the user separately asks to remove it:
organizations, employees, login identities, password setup records, OAuth/device/session/token
records, auth security events, labels, employee-label links, skill entries, retrieval configs, and
secrets.

## Workflow

1. Read the repository's current `AGENTS.md`, Prisma schema, staging runtime notes, and any
   existing cleanup scripts before acting; table names and release boundaries can change.
2. Resolve the target (`orgId`, employee email, or employee id) through read-only queries. Never
   infer `default-org` unless the user named it or the surrounding task clearly identifies it.
3. Run a dry-run inventory that counts every business table above, enumerates exact document IDs,
   import batch IDs, partition job IDs, structured partition IDs, storage-garbage IDs, all four
   object-key sources, and Qdrant collection/point IDs, and separately counts preserved
   identity/config tables.
4. For staging, execute from the staging server's `release-ops` runtime or an equivalent
   fail-closed operator runtime that proves it is connected to the approved staging RDS/Qdrant/OSS
   environment. Do not use local `.env` values to mutate staging.
5. Delete external artifacts by exact DB-recorded target first: Qdrant points by collection/id,
   then source, temporary, derived-partition, and storage-garbage OSS objects by their inventoried
   keys. If there are no document records, it is acceptable to verify Qdrant by `orgId` payload,
   but do not blindly delete OSS prefixes without an object inventory.
6. Delete database rows in current dependency order: business audit logs, document-label links,
   processing runs, chunks, indexes, import-window claims, structured partitions, storage-garbage
   rows, quarantine certificates, partition import jobs, row-backed dataset rows, import batches,
   then documents. Use the repository cleanup implementation as the authority if the schema or
   dependency order has changed.
7. Verify every business count is zero for the target, including `structured_partitions`,
   `partition_import_jobs`, and `storage_garbage`; verify Qdrant target count is zero and every
   inventoried source/temporary/derived/garbage OSS key is gone; confirm preserved identity/config
   counts remain present and staging health still passes.

Record only safe facts in the handoff: counts, table categories, non-secret resource names, and
whether the deletion was hard-delete. Never print passwords, DSNs, tokens, signed URLs, raw
headers, private keys, or full customer document contents.

## Exact store partition mode

Use the separate release-ops `partition-store-cleanup.js` entrypoint for an explicitly
confirmed organization, enterprise, and store scope. It supports only current `business` and
`dishes` partitions and affected derived download packages. Keep VIP, dish catalogs, delivery,
shared supplier data, source import jobs/runs (including mixed-store imports), accounts and
sessions. This operator action is never an employee MCP tool.

Create a private preview file in a durable operator-mounted directory:

```sh
node dist/release/partition-store-cleanup.js --target staging --org-id '<confirmed-org-id>' \
  --enterprise '<enterprise-name>' --datasets business,dishes \
  --store-name-contains '["<literal-store-fragment>"]' --inventory /private/store-preview.json
```

Use either `--store-names '["<exact-store-name>"]'` or `--store-name-contains '["<literal-fragment>"]'`.
Contains terms are NFC/trimmed, case-sensitive literal OR matches, not SQL wildcards. Optional
`--start-date YYYY-MM-DD` and `--end-date YYYY-MM-DD` narrow the range. No store predicate, empty
matches, ambiguous enterprise identity, or unrecognized organization are accepted. The CLI
requires the exact staging RDS identity and approved Beijing OSS bucket/endpoint/prefix.

Review the 0600 file containing scope, partition IDs, store keys/names, dates, checksums,
object keys, confidentiality and preserved counts. It refuses to overwrite an existing preview.
Do not post the full file into chats or logs. Real deletion requires separate explicit human
confirmation of this organization and preview fingerprint; implementation or release approval
alone does not authorize cleanup.

```sh
node dist/release/partition-store-cleanup.js --execute --target staging \
  --org-id '<confirmed-org-id>' --inventory /private/store-preview.json --confirm '<fingerprint>'
```

Execution rechecks the inventory under Serializable locks. Changed targets abort the whole
transaction. Directory deletion, affected bundle invalidation and exact-key garbage registration
commit together. Source jobs/runs remain. Old bundle workers are fenced, and registered unfinished
uploads retain repeated-deletion tombstones for late writes. Existing garbage collection retries
external deletion; the execute summary reports `externalCleanupPending: true` and must not be
reported as complete physical removal. Verify target directory absence, exact source/package
object removal, retained stores/accounts, and service health before declaring completion. Treat
remaining garbage/errors or active late upload candidates as pending; never use prefix deletion.

The older `staging-upload-domain-cleanup` entrypoint still has whole-database scope, not store
scope. Its inventory currently fails closed when any partition download request exists, before
any external deletion, because that entrypoint does not yet support download-request cleanup.
Use a compatible future release for overall clearing, or this dedicated CLI for an authorized
store scope. Do not bypass the guard or manually guess package object keys.
