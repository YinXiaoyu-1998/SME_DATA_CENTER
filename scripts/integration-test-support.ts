export interface CleanupFailure {
  scope: string;
  error: unknown;
}

export interface CommandFailureResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function formatCleanupFailures(failures: CleanupFailure[]): string {
  return ["Integration cleanup failed:", ...failures.map(formatCleanupFailure)].join("\n");
}

export function formatCommandFailure(
  command: string,
  args: readonly string[],
  result: CommandFailureResult
): string {
  return [
    `Command failed (${result.exitCode === null ? (result.signal ?? "unknown") : `exit ${result.exitCode}`}): ${command} ${args.join(" ")}`,
    result.stdout ? `stdout:\n${result.stdout}` : "",
    result.stderr ? `stderr:\n${result.stderr}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatCleanupFailure(failure: CleanupFailure): string {
  return `[${failure.scope}] ${describeFailure(failure.error)}`;
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}
