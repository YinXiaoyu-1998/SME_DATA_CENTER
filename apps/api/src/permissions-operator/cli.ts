import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const VERSION = "1.0.0";
const MAX_INPUT_BYTES = 262144;
const base = "/internal/permissions";
const operations = {
  "account.set": ["PATCH", "accounts", ["employeeId"], ["clearance", "grants"]],
  "category.create": [
    "POST",
    "categories",
    [],
    ["id", "name", "ownerships", "requiredDimensionIds", "retired"]
  ],
  "category.update": [
    "PATCH",
    "categories",
    ["id"],
    ["name", "confidentialityLevel", "ownerships", "requiredDimensionIds", "retired"]
  ],
  "store.set": ["POST", "stores", [], ["enterpriseKey", "enterpriseName", "name", "retired"]],
  "dimension.create": ["POST", "dimensions", [], ["id", "name", "retired"]],
  "dimension.update": ["PATCH", "dimensions", ["id"], ["name", "retired"]],
  "value.create": ["POST", "dimensions", ["dimensionId"], ["id", "name", "retired"]],
  "value.update": ["PATCH", "dimensions", ["dimensionId", "id"], ["name", "retired"]],
  "document.set": [
    "PATCH",
    "documents",
    ["documentId"],
    ["categoryId", "fileConfidentialityLevel", "scopes", "historicalSupplementReason"]
  ],
  "enterprise.declare": ["POST", "enterprises", [], ["name"]]
} as const;
export type PermissionOperation = keyof typeof operations;
const sections = [
  "all",
  "accounts",
  "categories",
  "stores",
  "dimensions",
  "enterprises",
  "documents",
  "readiness"
] as const;
export type PermissionSection = (typeof sections)[number];
type Common = { orgId: string; requestedByAdminId: string };
export type PermissionsOperatorCommand =
  | { kind: "help" | "version" }
  | { kind: "completion"; shell: "bash" | "zsh" | "fish" }
  | (Common & { kind: "inspect"; section: PermissionSection; search?: string; cursor?: string })
  | (Common & {
      kind: "apply";
      operatorId: string;
      reason: string;
      requestReference: string;
      expectedVersion: string;
      operation: PermissionOperation;
      input: string;
      execute: boolean;
    });
export type DataCommand = Extract<PermissionsOperatorCommand, Common>;
export interface PermissionChange {
  method: "POST" | "PATCH";
  url: string;
  body: Record<string, unknown>;
}
export interface PermissionsOperatorRuntime {
  inspect(
    section: PermissionSection,
    query?: { search?: string; cursor?: string }
  ): Promise<{ authorizationVersion: string; [key: string]: unknown }>;
  apply(change: PermissionChange): Promise<unknown>;
  close(): Promise<void>;
}
const commonFlags = ["org-id", "requested-by-admin-id"];
const inspectFlags = [...commonFlags, "section", "search", "cursor"];
const applyFlags = [
  ...commonFlags,
  "operator-id",
  "reason",
  "request-reference",
  "expected-version",
  "operation",
  "input",
  "execute"
];
function bounded(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("OPERATOR_INVALID_ARGUMENT");
  return value.trim();
}
export function parsePermissionsOperatorArgs(args: string[]): PermissionsOperatorCommand {
  if (!args.length || (args.length === 1 && args[0] === "--help")) return { kind: "help" };
  if (args.length === 1 && args[0] === "--version") return { kind: "version" };
  if (args.length === 2 && args[0] === "completion" && ["bash", "zsh", "fish"].includes(args[1]!))
    return { kind: "completion", shell: args[1] as "bash" | "zsh" | "fish" };
  const kind = args[0];
  if (kind !== "inspect" && kind !== "apply") throw new Error("OPERATOR_UNKNOWN_COMMAND");
  const flags = kind === "inspect" ? inspectFlags : applyFlags;
  const { values, tokens } = parseArgs({
    args: args.slice(1),
    allowPositionals: false,
    strict: true,
    tokens: true,
    options: Object.fromEntries(
      flags.map((flag) => [flag, { type: flag === "execute" ? "boolean" : "string" }])
    )
  });
  const seen = new Set<string>();
  for (const token of tokens)
    if (token.kind === "option") {
      if (seen.has(token.name)) throw new Error("OPERATOR_DUPLICATE_OPTION");
      seen.add(token.name);
    }
  const common = {
    orgId: bounded(values["org-id"], 64),
    requestedByAdminId: bounded(values["requested-by-admin-id"], 32)
  };
  if (kind === "inspect") {
    const section = values["section"] ?? "all";
    if (!sections.includes(section as PermissionSection))
      throw new Error("OPERATOR_INVALID_SECTION");
    return {
      kind,
      ...common,
      section: section as PermissionSection,
      ...(values["search"] === undefined ? {} : { search: bounded(values["search"], 256) }),
      ...(values["cursor"] === undefined ? {} : { cursor: bounded(values["cursor"], 32) })
    };
  }
  const operation = bounded(values["operation"], 64);
  if (!Object.hasOwn(operations, operation)) throw new Error("OPERATOR_UNKNOWN_OPERATION");
  const expectedVersion = bounded(values["expected-version"], 20);
  if (!/^(0|[1-9]\d*)$/.test(expectedVersion) || BigInt(expectedVersion) > 18446744073709551615n)
    throw new Error("OPERATOR_INVALID_VERSION");
  return {
    kind,
    ...common,
    operation: operation as PermissionOperation,
    expectedVersion,
    operatorId: bounded(values["operator-id"], 128),
    reason: bounded(values["reason"], 2048),
    requestReference: bounded(values["request-reference"], 256),
    input: bounded(values["input"], 4096),
    execute: values["execute"] === true
  };
}
export function planPermissionChange(
  operation: string,
  payload: unknown,
  expectedVersion: string
): PermissionChange {
  if (!Object.hasOwn(operations, operation)) throw new Error("OPERATOR_UNKNOWN_OPERATION");
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("OPERATOR_INVALID_INPUT");
  const [method, directory, selectors, fields] = operations[operation as PermissionOperation];
  const allowed = new Set<string>([...selectors, ...fields]);
  if (Object.keys(payload).some((key) => !allowed.has(key)))
    throw new Error("OPERATOR_UNEXPECTED_INPUT_FIELD");
  const input = payload as Record<string, unknown>;
  const ids = selectors.map((key) => {
    const value = bounded(input[key], 64);
    if (/[/?#]/.test(value) || value === "." || value === "..")
      throw new Error("OPERATOR_INVALID_TARGET");
    return encodeURIComponent(value);
  });
  const suffix = operation.startsWith("value.")
    ? `/${ids[0]}/values${method === "PATCH" ? `/${ids[1]}` : ""}`
    : ids.length
      ? `/${ids.join("/")}`
      : "";
  const bodyFields = new Set<string>(fields);
  const body = Object.fromEntries(Object.entries(input).filter(([key]) => bodyFields.has(key)));
  return { method, url: `${base}/${directory}${suffix}`, body: { ...body, expectedVersion } };
}
export async function runPermissionsOperator(
  command: PermissionsOperatorCommand,
  dependencies: {
    open(command: DataCommand): Promise<PermissionsOperatorRuntime>;
    readInput(path: string): Promise<unknown>;
    stdout(line: string): void;
    interrupted?(): boolean;
  }
): Promise<void> {
  if (command.kind === "help") {
    dependencies.stdout(permissionsOperatorHelp());
    return;
  }
  if (command.kind === "version") {
    dependencies.stdout(VERSION);
    return;
  }
  if (command.kind === "completion") {
    const words = [
      "inspect",
      "apply",
      "completion",
      "--help",
      "--version",
      ...applyFlags.map((f) => `--${f}`),
      ...inspectFlags.map((f) => `--${f}`),
      ...Object.keys(operations)
    ].join(" ");
    dependencies.stdout(
      command.shell === "bash"
        ? `complete -W '${words}' permissions-operator`
        : command.shell === "zsh"
          ? `compdef '_arguments "*: :(${words})"' permissions-operator`
          : `complete -c permissions-operator -f -a '${words}'`
    );
    return;
  }
  if (command.kind !== "inspect" && command.kind !== "apply") return;
  const change =
    command.kind === "apply"
      ? planPermissionChange(
          command.operation,
          await dependencies.readInput(command.input),
          command.expectedVersion
        )
      : undefined;
  if (dependencies.interrupted?.()) throw new Error("OPERATOR_INTERRUPTED");
  const runtime = await dependencies.open(command);
  try {
    const snapshot = await runtime.inspect(
      command.kind === "inspect" ? command.section : "all",
      command.kind === "inspect"
        ? {
            ...(command.search ? { search: command.search } : {}),
            ...(command.cursor ? { cursor: command.cursor } : {})
          }
        : {}
    );
    if (dependencies.interrupted?.()) throw new Error("OPERATOR_INTERRUPTED");
    if (command.kind === "inspect") {
      dependencies.stdout(JSON.stringify(snapshot));
      return;
    }
    if (snapshot.authorizationVersion !== command.expectedVersion)
      throw new Error("AUTHORIZATION_VERSION_CONFLICT");
    dependencies.stdout(
      JSON.stringify(
        command.execute
          ? await runtime.apply(change!)
          : {
              dryRun: true,
              orgId: command.orgId,
              requestedByAdminId: command.requestedByAdminId,
              operatorId: command.operatorId,
              requestReference: command.requestReference,
              reason: command.reason,
              current: snapshot,
              change,
              note: "Preview is read-only; execution rechecks all references, policy and the version atomically."
            }
      )
    );
  } finally {
    await runtime.close();
  }
}
export function permissionsOperatorHelp(): string {
  return `SMEDC internal permissions operator ${VERSION}
Usage:
  permissions-operator inspect --org-id ID --requested-by-admin-id ID [--section ${sections.join("|")}] [--search TEXT] [--cursor ID]
  permissions-operator apply --org-id ID --requested-by-admin-id ID --operator-id ID --request-reference REF --reason TEXT --expected-version N --operation NAME --input FILE|- [--execute]
  permissions-operator completion bash|zsh|fish
  permissions-operator --help | --version
Operations: ${Object.keys(operations).join(", ")}
Apply previews by default. --execute saves one operation. Input is JSON, maximum ${MAX_INPUT_BYTES} bytes.
An active same-enterprise admin must have requested the change. Runtime database access authenticates the operator; operator-id and request-reference are audit declarations, not credentials.
Use release-ops with its approved server runtime environment. No public listener, account password, token, role change, activation, or arbitrary SQL/API path is supported.`;
}
async function readInput(path: string): Promise<unknown> {
  let text: string;
  if (path === "-") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_INPUT_BYTES) throw new Error("OPERATOR_INPUT_TOO_LARGE");
      chunks.push(bytes);
    }
    text = Buffer.concat(chunks).toString("utf8");
  } else {
    const file = await open(path, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error("OPERATOR_INVALID_INPUT");
      const bytes = Buffer.alloc(MAX_INPUT_BYTES + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_INPUT_BYTES) throw new Error("OPERATOR_INPUT_TOO_LARGE");
      text = bytes.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("OPERATOR_INVALID_JSON");
  }
}
async function main() {
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    process.stdin.destroy();
  };
  process.once("SIGINT", interrupt);
  try {
    await runPermissionsOperator(parsePermissionsOperatorArgs(process.argv.slice(2)), {
      readInput,
      interrupted: () => interrupted,
      open: async (command) => {
        if (interrupted) throw new Error("OPERATOR_INTERRUPTED");
        const { openPermissionsOperatorRuntime } = await import("./runtime.js");
        return openPermissionsOperatorRuntime(command);
      },
      stdout: (line) => process.stdout.write(`${line}\n`)
    });
  } finally {
    process.off("SIGINT", interrupt);
    if (interrupted) {
      process.stderr.write(
        "Interrupted. Inspect the current version before retrying; an in-flight transaction may have completed.\n"
      );
      process.exitCode = 130;
    }
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    process.stderr.write(
      `${/^(OPERATOR_|AUTHORIZATION_|INVALID_|CATEGORY_|RESOURCE_|SOURCE_|STORE_)[A-Z_]+$/.test(message) ? message : "OPERATOR_FAILED"}. Inspect configuration and use --help; no automatic retry was performed.\n`
    );
    if (process.exitCode !== 130) process.exitCode = 1;
  });
