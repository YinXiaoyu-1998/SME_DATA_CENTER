import { setTimeout as delay } from "node:timers/promises";
import { assertLedgerDate } from "../packages/ledger-archive/src/scope.js";
import {
  normalizeLedgerInternalSelection,
  type createLedgerArchiveService
} from "../packages/ledger-archive/src/service.js";
import type { LedgerInternalSelection } from "../packages/ledger-archive/src/repository.js";

type Common = { orgId: string; allowRemote: boolean; wait: boolean };
type Mutation = { execute: boolean; requestKey?: string; operator?: string };
export class LedgerCliUsageError extends Error {}

export type LedgerCliCommand =
  | (Common & Mutation & { kind: "refresh"; selection: LedgerInternalSelection })
  | (Common & Mutation & { kind: "retry-failed"; requestId: string })
  | (Common & { kind: "status"; requestId: string });

export const ledgerCliHelp = `Usage: node dist/release/ledger-pdf.js <command> [options]

refresh --org-id <id> (--store <exact-name> ... | --all-stores)
        (--date <YYYY-MM-DD> ... | --start-date <date> --end-date <date> | --all-dates)
        [--dry-run | --execute --request-key <key> --operator <label>] [--wait]
retry-failed --org-id <id> --request-id <id>
        [--dry-run | --execute --request-key <new-key> --operator <label>] [--wait]
status --org-id <id> --request-id <id> [--wait]

Default: dry-run (no writes, uploads or rendering). DATABASE_URL comes from the
environment; remote databases require --allow-remote. Interrupted --wait leaves
submitted jobs running. Resume interrupted enumeration with the same request key.
Source records are read only. Store names are exact; repeated stores/dates merge.
`;

export function parseLedgerCliArgs(argv: readonly string[]): LedgerCliCommand {
  const kind = argv[0];
  if (kind !== "refresh" && kind !== "status" && kind !== "retry-failed")
    throw new LedgerCliUsageError("Choose refresh, status or retry-failed.");
  const allowedValues = new Set([
    "--org-id",
    ...(kind === "refresh"
      ? ["--store", "--date", "--start-date", "--end-date"]
      : ["--request-id"]),
    ...(kind !== "status" ? ["--request-key", "--operator"] : [])
  ]);
  const allowedFlags = new Set([
    "--allow-remote",
    "--wait",
    ...(kind !== "status" ? ["--execute", "--dry-run"] : []),
    ...(kind === "refresh" ? ["--all-stores", "--all-dates"] : [])
  ]);
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index]!;
    if (allowedFlags.has(flag)) {
      if (flags.has(flag)) throw new LedgerCliUsageError(`Duplicate ${flag}.`);
      flags.add(flag);
      continue;
    }
    if (!allowedValues.has(flag)) throw new LedgerCliUsageError("Unknown option.");
    const value = argv[++index];
    if (!value || value.startsWith("--") || !value.trim())
      throw new LedgerCliUsageError(`Missing value for ${flag}.`);
    if (flag !== "--store" && flag !== "--date" && values.has(flag))
      throw new LedgerCliUsageError(`Duplicate ${flag}.`);
    values.set(flag, [...(values.get(flag) ?? []), flag === "--store" ? value : value.trim()]);
  }
  const required = (flag: string, max: number) => {
    const value = values.get(flag)?.[0];
    if (!value || value.length > max)
      throw new LedgerCliUsageError(`${flag} is required and must be at most ${max} characters.`);
    return value;
  };
  const common = {
    orgId: required("--org-id", 64),
    allowRemote: flags.has("--allow-remote"),
    wait: flags.has("--wait")
  };
  if (kind === "status") return { ...common, kind, requestId: required("--request-id", 32) };
  const execute = flags.has("--execute");
  if (execute && flags.has("--dry-run"))
    throw new LedgerCliUsageError("Choose --dry-run or --execute.");
  if (common.wait && !execute) throw new LedgerCliUsageError("--wait requires --execute.");
  const mutation: Mutation = {
    execute,
    ...(execute
      ? { requestKey: required("--request-key", 255), operator: required("--operator", 255) }
      : {})
  };
  if (kind === "retry-failed")
    return { ...common, ...mutation, kind, requestId: required("--request-id", 32) };
  const stores = values.get("--store");
  if (Number(Boolean(stores)) + Number(flags.has("--all-stores")) !== 1)
    throw new LedgerCliUsageError("Choose --store or --all-stores.");
  const dates = values.get("--date");
  const range = values.has("--start-date") || values.has("--end-date");
  if (Number(Boolean(dates)) + Number(range) + Number(flags.has("--all-dates")) !== 1)
    throw new LedgerCliUsageError("Choose dates, date range or --all-dates.");
  dates?.forEach(assertLedgerDate);
  const selection = normalizeLedgerInternalSelection({
    storeNames: stores ?? null,
    ...(range
      ? { startDate: required("--start-date", 10), endDate: required("--end-date", 10) }
      : { dates: dates ?? null })
  });
  return { ...common, ...mutation, kind, selection };
}

export function assertLedgerCliDatabase(databaseUrl: string, allowRemote: boolean) {
  let target: URL;
  try {
    target = new URL(databaseUrl);
  } catch {
    throw new LedgerCliUsageError("Invalid DATABASE_URL.");
  }
  if (
    target.protocol !== "mysql:" ||
    !target.hostname ||
    !/^\/[a-zA-Z0-9_-]+$/.test(target.pathname)
  )
    throw new LedgerCliUsageError("Invalid MySQL DATABASE_URL.");
  const remote = target.hostname !== "localhost" && target.hostname !== "127.0.0.1";
  if (remote && !allowRemote)
    throw new LedgerCliUsageError(
      "Ledger PDF CLI refuses a non-local database without --allow-remote."
    );
  return { host: target.hostname, database: target.pathname.slice(1), remote };
}

export async function runLedgerCli(
  command: LedgerCliCommand,
  {
    archive,
    now,
    output,
    signal,
    poll = () => delay(1000, undefined, { signal })
  }: {
    archive: ReturnType<typeof createLedgerArchiveService>;
    now: () => Date;
    output: (value: unknown) => void;
    signal?: AbortSignal;
    poll?: () => Promise<void>;
  }
): Promise<number> {
  const emit = (value: object) =>
    output({ at: now().toISOString(), orgId: command.orgId, ...value });
  const status = async (requestId: string) => {
    let cursor: string | undefined;
    let result;
    do {
      result = await archive.getRequestStatus({
        orgId: command.orgId,
        requestId,
        ...(cursor ? { cursor } : {})
      });
      if (!result) throw new LedgerCliUsageError("LEDGER_REQUEST_NOT_FOUND");
      emit({ command: "status", ...result });
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    return result!;
  };
  const wait = async (requestId: string) => {
    try {
      for (;;) {
        if (signal?.aborted) {
          emit({ requestId, interrupted: true, jobsContinue: true });
          return 130;
        }
        const result = await status(requestId);
        if (result.status === "failed" || result.status === "partial_failed") return 1;
        if (result.status === "succeeded") return 0;
        await poll();
      }
    } catch (error) {
      if (!signal?.aborted) throw error;
      emit({ requestId, interrupted: true, jobsContinue: true });
      return 130;
    }
  };
  if (command.kind === "status") {
    if (command.wait) return wait(command.requestId);
    const result = await status(command.requestId);
    return result.status === "failed" || result.status === "partial_failed" ? 1 : 0;
  }
  if (!command.execute) {
    const pages =
      command.kind === "refresh"
        ? archive.previewAllPartitions({ orgId: command.orgId, selection: command.selection })
        : archive.previewFailedRequest({ orgId: command.orgId, requestId: command.requestId });
    const stores = new Set<string>();
    let partitionCount = 0;
    for await (const page of pages) {
      for (const key of page.keys) stores.add(key.storeName);
      partitionCount += page.keys.length;
    }
    emit({
      command: command.kind,
      mode: "dry-run",
      scope:
        command.kind === "refresh" ? command.selection : { retryOfRequestId: command.requestId },
      storeCount: stores.size,
      partitionCount,
      estimatedTaskCount: partitionCount
    });
    return 0;
  }
  const input = {
    orgId: command.orgId,
    actor: { kind: "operator" as const, label: command.operator! },
    idempotencyKey: command.requestKey!,
    onReserved: (request: { requestId: string; status: string }) =>
      emit({ mode: "execute", enumeration: "pending", ...request }),
    ...(signal ? { signal } : {})
  };
  const request =
    command.kind === "refresh"
      ? await archive.requestAllPartitions({ ...input, selection: command.selection })
      : await archive.retryFailedRequest({ ...input, requestId: command.requestId });
  emit({
    command: command.kind,
    mode: "execute",
    scope: command.kind === "refresh" ? command.selection : { retryOfRequestId: command.requestId },
    operator: command.operator,
    requestKey: command.requestKey,
    ...request
  });
  if (signal?.aborted) {
    emit({ requestId: request.requestId, interrupted: true, jobsContinue: true });
    return 130;
  }
  if (command.wait) return wait(request.requestId);
  return request.status === "failed" || request.status === "partial_failed" ? 1 : 0;
}
