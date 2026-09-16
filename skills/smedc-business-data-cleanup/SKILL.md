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

Business data includes uploaded source documents, source object keys, evidence chunks and Qdrant
points, document indexes, processing runs, import batches, import-window claims, structured rows
(`dish_rows`, `business_rows`, `vip_rows`, `dish_catalog_rows`, `delivery_ledger_rows`,
`supplier_catalog_rows`), quarantine certificates, document-label links, and business audit logs
for document/import/quarantine actions.

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
   import batch IDs, storage object keys, and Qdrant collection/point IDs, and separately counts
   preserved identity/config tables.
4. For staging, execute from the staging server's `release-ops` runtime or an equivalent
   fail-closed operator runtime that proves it is connected to the approved staging RDS/Qdrant/OSS
   environment. Do not use local `.env` values to mutate staging.
5. Delete external artifacts by exact DB-recorded target first: Qdrant points by collection/id,
   then OSS objects by storage key. If there are no document records, it is acceptable to verify
   Qdrant by `orgId` payload, but do not blindly delete OSS prefixes without an object inventory.
6. Delete database rows in dependency order: business audit logs, document labels, processing
   runs, chunks, indexes, import-window claims, all structured row tables, quarantine
   certificates, import batches, then documents.
7. Verify every business count is zero for the target, Qdrant target count is zero, known OSS
   keys are gone, preserved identity/config counts remain present, and staging health still passes.

Record only safe facts in the handoff: counts, table categories, non-secret resource names, and
whether the deletion was hard-delete. Never print passwords, DSNs, tokens, signed URLs, raw
headers, private keys, or full customer document contents.
