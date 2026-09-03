#!/usr/bin/env bash
# Read-only, timestamp-bounded RDS diagnostics. Requires aliyun and jq.
set -euo pipefail
if [[ $# -ne 3 ]]; then
  echo "Usage: bash scripts/rds-diagnostics.sh INSTANCE_ID START_UTC END_UTC" >&2
  echo "Times: YYYY-MM-DDTHH:mmZ (RDS API uses UTC)." >&2
  exit 2
fi
instance_id="$1"
start_utc="$2"
end_utc="$3"

aliyun rds describe-db-instance-attribute --db-instance-id "$instance_id" |
  jq '{instance: [.Items.DBInstanceAttribute[] | {id: .DBInstanceId, status: .DBInstanceStatus, lock: .LockMode, lockReason: .LockReason}]}'
aliyun rds describe-parameters --db-instance-id "$instance_id" |
  jq '{logging: [.RunningParameters.DBInstanceParameter[] | select(.ParameterName | test("^(slow_query_log|long_query_time|log_error_verbosity|innodb_print_all_deadlocks|performance_schema)$")) | {name: .ParameterName, value: .ParameterValue}]}'
# Do not export SQL text, bind values, credentials or raw error messages.
# Full messages remain available to operators in the authenticated RDS console.
aliyun rds describe-error-logs --db-instance-id "$instance_id" --start-time "$start_utc" --end-time "$end_utc" --page-size 100 |
  jq '{errorLogCount: .TotalRecordCount, firstPage: [.Items.ErrorLog[] | {time: .CreateTime, code: ([.ErrorInfo | scan("MY-[0-9]+")][0] // null), connectionId: ((try (.ErrorInfo | capture("[Cc]onnection (?<id>[0-9]+)").id) catch null) // null), connectionFailureReason: ((.ErrorInfo | match("Got (an error|timeout) (reading|writing) communication packets|Malformed communication packet|Bad handshake|Access denied"; "i").string) // null), communicationError: (.ErrorInfo | test("packet|connection|connect"; "i")), deadlock: (.ErrorInfo | test("deadlock"; "i"))}]}'
aliyun rds describe-slow-log-records --db-instance-id "$instance_id" --start-time "$start_utc" --end-time "$end_utc" --page-size 100 |
  jq '{slowLogCount: .TotalRecordCount, firstPage: [.Items.SQLSlowRecord[] | {time: .ExecutionStartTime, querySeconds: .QueryTimes, lockSeconds: .LockTimes, examinedRows: .ParseRowCounts, sqlHash: .SQLHash} ]}'
