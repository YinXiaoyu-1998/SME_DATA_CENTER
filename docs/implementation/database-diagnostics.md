# Database diagnostics and structured-upload recovery

The API and worker use the shared `createDatabaseAdapter` with the MariaDB
driver's text protocol. Values are still bound and escaped by the driver; callers
must continue using Prisma queries and parameterized SQL.

## Why this configuration exists

On 2026-09-03, staging RDS MySQL 8.0.36 behind its Serverless proxy reproduced
`P2039 / MySQL 1835 / HY000` during overlapping prepared statements on one
connection. It requires neither large files nor high request concurrency.
The smallest reproducer overlaps `SELECT ?` (followed by another `SELECT ?`)
with `SELECT ?, ?`, using the binary protocol and `prepareCacheLength=0`.
The same pattern passed on local MySQL 8.4. RDS passed with text protocol.

This isolates an incompatibility in the driver/proxy prepared-statement path.
It does not establish which vendor's internal implementation is defective.
Enabling the statement cache is insufficient: replaying the actual overlapping
relation queries still failed with the cache enabled. Do not replace this fix
with a smaller connection pool or unrestricted retries.

The real MCP comparison used an isolated synthetic organization and 50-item CSV
receipts. The deployed baseline failed 6 of 36 uploads; the candidate passed all
36 at request concurrency 1, 2 and 4. Four simultaneous replays of one additional
receipt resolved to one import/job. All 37 candidate imports applied exactly
1,850 rows: mean registration-to-apply 1.84 seconds, median 1.77 seconds, maximum
3.01 seconds. Test records, identity/session and 70 original objects were removed.
The candidate ran in a disposable release-ops process against real RDS/OSS and
the running staging worker; this is pre-merge verification, not a production
release of the fix.

The read-only regression can run against either database:

```bash
# DATABASE_URL must already be provided securely; never print it.
RUN_DATABASE_PROTOCOL_INTEGRATION=1 npx vitest run packages/db/src/adapter.integration.test.ts
```

## Logs and RDS settings

Verified staging instance: `rm-2ze2m5q387ydb9724`, Beijing. The following settings
are active: `slow_query_log=ON`, `long_query_time=1`, `log_error_verbosity=3`.
`innodb_print_all_deadlocks=ON` was enabled without restarting RDS on 2026-09-03.
`performance_schema` remains disabled; enabling it requires an RDS restart and
is not necessary for this protocol fix. No paid SQL-audit service was enabled.

Collect a bounded time window (UTC, not local Beijing time):

```bash
bash scripts/rds-diagnostics.sh rm-2ze2m5q387ydb9724 \
  2026-09-03T02:00Z 2026-09-03T03:00Z
```

The script reports current locks/log settings, counts and the first 100 error/
slow-log records without raw SQL or error messages. If counts exceed 100, use
the RDS console or the same CLI endpoints with `--page-number` to inspect the
remaining records. Full messages are available in the authenticated RDS console.
See [Alibaba's error/slow-log documentation](https://www.alibabacloud.com/help/en/rds/apsaradb-rds-for-mysql/view-error-logs-and-slow-logs).

An empty server error log does not prove that no client failed: an error returned
by the proxy may never reach the MySQL engine log, and sub-second protocol failures
are not slow queries. Correlate RDS time windows with API `reqId`, stage,
`importBatchId` and `sourceDocumentId` in container logs.

- `structured_import_db_retry`: stage, attempt, maximum attempts, delay,
  `retrying` / `recovered` / `exhausted`, Prisma code, MySQL code and SQLSTATE.
- `database_connection_error`: timestamp, safe driver codes and fatal flag for
  transaction-connection error events. Not every query error emits this event.
- Existing `structured_import_timing` events distinguish reservation, storage,
  enqueue and total request time from worker processing time.

Neither new diagnostic event includes SQL, bind values, credentials or raw driver
messages. Existing bounded Docker log rotation remains in effect.

## Recovery behavior

Only idempotent reservation and enqueue operations retry: at most three attempts,
with 100 ms and 300 ms delays, each using a fresh transaction. Recognized errors
are connection unavailability/closure, deadlocks, lock timeouts and the observed
1835 protocol failure. Validation, permissions, conflicting receipt/idempotency
keys and unrelated database errors are not retried.

Reservation checks the existing fingerprint and receipt/idempotency keys before
writing. Enqueue checks the existing processing run before creating one; the
unique job key still resolves races. A committed operation whose acknowledgement
was lost is thus recovered on the next attempt without duplicate documents/jobs.
This retry helper must not wrap arbitrary writes or replay individual statements
inside a failed transaction.

If all attempts fail, the existing retryable API error is returned. A client
retry must reuse the same file, metadata and idempotency key. A reservation that
never reached enqueue is not automatically repaired in the background; a later
same-key upload resumes it. HTTP 202 still means queued, not applied.
