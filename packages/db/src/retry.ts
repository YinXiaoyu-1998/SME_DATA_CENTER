import { setTimeout as delay } from "node:timers/promises";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

// Deliberately exclude SQL, parameters, DSNs and raw driver messages.
export function databaseErrorDetails(error: unknown) {
  const outer = record(error);
  const cause = record(record(record(outer.meta).driverAdapterError).cause);
  const rawCode = cause.originalCode ?? cause.code ?? outer.errno;
  return {
    code:
      typeof outer.code === "string" && /^[A-Z0-9_]+$/.test(outer.code) ? outer.code : undefined,
    mysqlCode: /^\d+$/.test(String(rawCode)) ? Number(rawCode) : undefined,
    sqlState:
      typeof (cause.state ?? outer.sqlState) === "string" &&
      /^[A-Z0-9]{5}$/.test(String(cause.state ?? outer.sqlState))
        ? String(cause.state ?? outer.sqlState)
        : undefined
  };
}

export interface DatabaseRetryEvent {
  outcome: "retrying" | "recovered" | "exhausted";
  attempt: number;
  maxAttempts: number;
  delayMs?: number;
  code?: string;
  mysqlCode?: number;
  sqlState?: string;
}

/** Only for operations that re-read authoritative state before replaying writes. */
export async function retryIdempotentDatabaseOperation<T>(
  operation: () => Promise<T>,
  onEvent?: (event: DatabaseRetryEvent) => void
): Promise<T> {
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await operation();
      if (attempt > 1) onEvent?.({ outcome: "recovered", attempt, maxAttempts });
      return result;
    } catch (error) {
      const details = databaseErrorDetails(error);
      const transient =
        ["P1001", "P1017", "P2034"].includes(details.code ?? "") ||
        [1205, 1213, 1835, 2006, 2013].includes(details.mysqlCode ?? 0);
      if (!transient) throw error;
      if (attempt === maxAttempts) {
        onEvent?.({ outcome: "exhausted", attempt, maxAttempts, ...details });
        throw error;
      }
      const delayMs = attempt === 1 ? 100 : 300;
      onEvent?.({ outcome: "retrying", attempt, maxAttempts, delayMs, ...details });
      await delay(delayMs);
    }
  }
}
