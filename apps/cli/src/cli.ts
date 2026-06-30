import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_API_URL = "http://127.0.0.1:3000";
const DEFAULT_DOCUMENT_TYPE = "raw_material";

export interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface CliRuntime {
  cwd: string;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  io: CliIo;
}

interface ParsedArgs {
  positionals: string[];
  options: Map<string, string[]>;
}

interface HubCliSession {
  apiUrl: string;
  accessToken: string;
  employee: {
    id: string;
    email: string;
    role: string;
    labels: string[];
  };
}

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1
  ) {
    super(message);
  }
}

export async function runCli(argv: string[], runtime: Partial<CliRuntime> = {}): Promise<number> {
  const resolvedRuntime = resolveRuntime(runtime);

  try {
    await dispatch(argv, resolvedRuntime);
    return 0;
  } catch (error) {
    const cliError = error instanceof CliError ? error : new CliError(errorToMessage(error), 1);
    resolvedRuntime.io.stderr.write(`${cliError.message}\n`);
    return cliError.exitCode;
  }
}

async function dispatch(argv: string[], runtime: CliRuntime): Promise<void> {
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    runtime.io.stdout.write(`${helpText()}\n`);
    return;
  }

  if (command === "login") {
    await login(rest, runtime);
    return;
  }

  if (command === "documents") {
    await documents(rest, runtime);
    return;
  }

  throw new CliError(`Unknown command: ${command}\n\n${helpText()}`);
}

async function login(argv: string[], runtime: CliRuntime): Promise<void> {
  const parsed = parseArgs(argv);
  const email = firstOption(parsed, "email");

  if (!email) {
    throw new CliError("Missing required --email for login.");
  }

  const apiUrl = normalizeApiUrl(firstOption(parsed, "api-url") ?? runtime.env["HUB_API_URL"]);
  const response = await runtime.fetch(`${apiUrl}/auth/dev-login`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ email })
  });
  const body = await readJsonResponse(response);

  if (!response.ok) {
    throw new CliError(`Login failed: ${response.status} ${JSON.stringify(body)}`);
  }

  const session = parseLoginSession(body, apiUrl);
  const sessionFile = resolveSessionFile(parsed, runtime);
  await writeSession(sessionFile, session);

  writeJson(runtime, {
    ok: true,
    apiUrl: session.apiUrl,
    employee: session.employee,
    sessionFile
  });
}

async function documents(argv: string[], runtime: CliRuntime): Promise<void> {
  const [subcommand, ...rest] = argv;

  if (subcommand === "search") {
    await searchDocuments(rest, runtime);
    return;
  }

  if (subcommand === "upload") {
    await uploadDocument(rest, runtime);
    return;
  }

  throw new CliError("Usage: hub documents <search|upload> ...");
}

async function searchDocuments(argv: string[], runtime: CliRuntime): Promise<void> {
  const parsed = parseArgs(argv);
  const query = parsed.positionals.join(" ").trim();

  if (!query) {
    throw new CliError('Usage: hub documents search "保利店 美团"');
  }

  const session = await readSession(resolveSessionFile(parsed, runtime));
  const apiUrl = normalizeApiUrl(firstOption(parsed, "api-url") ?? session.apiUrl);
  const params = new URLSearchParams({
    q: query
  });
  const limit = firstOption(parsed, "limit");

  if (limit) {
    params.set("limit", limit);
  }

  const response = await runtime.fetch(`${apiUrl}/documents?${params.toString()}`, {
    headers: authorizationHeaders(session)
  });
  const body = await readJsonResponse(response);

  if (!response.ok) {
    throw new CliError(`Document search failed: ${response.status} ${JSON.stringify(body)}`);
  }

  writeJson(runtime, body);
}

async function uploadDocument(argv: string[], runtime: CliRuntime): Promise<void> {
  const parsed = parseArgs(argv);
  const filePath = parsed.positionals[0];

  if (!filePath) {
    throw new CliError("Usage: hub documents upload <file> --label <labelKey>");
  }

  const session = await readSession(resolveSessionFile(parsed, runtime));
  const apiUrl = normalizeApiUrl(firstOption(parsed, "api-url") ?? session.apiUrl);
  const absoluteFilePath = path.resolve(runtime.cwd, filePath);
  const fileBytes = await readFile(absoluteFilePath);
  const fileName = path.basename(absoluteFilePath);
  const form = new FormData();

  form.append("file", new Blob([fileBytes]), fileName);
  form.append("title", firstOption(parsed, "title") ?? fileName);
  form.append("documentType", firstOption(parsed, "type") ?? DEFAULT_DOCUMENT_TYPE);

  for (const label of parsed.options.get("label") ?? []) {
    form.append("labelKeys[]", label);
  }

  const sourceSystem = firstOption(parsed, "source-system");
  const sourceTime = firstOption(parsed, "source-time");

  if (sourceSystem) {
    form.append("sourceSystem", sourceSystem);
  }

  if (sourceTime) {
    form.append("sourceTime", sourceTime);
  }

  const response = await runtime.fetch(`${apiUrl}/documents`, {
    method: "POST",
    headers: authorizationHeaders(session),
    body: form
  });
  const body = await readJsonResponse(response);

  if (!response.ok) {
    throw new CliError(`Document upload failed: ${response.status} ${JSON.stringify(body)}`);
  }

  writeJson(runtime, body);
}

function resolveRuntime(runtime: Partial<CliRuntime>): CliRuntime {
  return {
    cwd: runtime.cwd ?? process.cwd(),
    env: runtime.env ?? process.env,
    fetch: runtime.fetch ?? fetch,
    io: runtime.io ?? {
      stdout: process.stdout,
      stderr: process.stderr
    }
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (!value) {
      continue;
    }

    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }

    const name = value.slice(2);
    const nextValue = argv[index + 1];

    if (!nextValue || nextValue.startsWith("--")) {
      throw new CliError(`Missing value for --${name}.`);
    }

    const values = options.get(name) ?? [];
    values.push(nextValue);
    options.set(name, values);
    index += 1;
  }

  return { positionals, options };
}

function firstOption(parsed: ParsedArgs, name: string): string | undefined {
  return parsed.options.get(name)?.[0];
}

function normalizeApiUrl(value: string | undefined): string {
  return (value ?? DEFAULT_API_URL).replace(/\/+$/, "");
}

function resolveSessionFile(parsed: ParsedArgs, runtime: CliRuntime): string {
  const configuredPath = firstOption(parsed, "session-file") ?? runtime.env["HUB_CLI_SESSION_FILE"];

  if (configuredPath) {
    return path.resolve(runtime.cwd, configuredPath);
  }

  return path.resolve(runtime.cwd, ".data", "hub-cli", "session.json");
}

async function writeSession(filePath: string, session: HubCliSession): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

async function readSession(filePath: string): Promise<HubCliSession> {
  try {
    const rawSession = await readFile(filePath, "utf8");
    return parseStoredSession(JSON.parse(rawSession));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new CliError("No CLI session found. Run `hub login --email <email>` first.");
    }

    throw error;
  }
}

function parseLoginSession(value: unknown, apiUrl: string): HubCliSession {
  if (!isRecord(value) || typeof value["accessToken"] !== "string") {
    throw new CliError("Login response did not include an access token.");
  }

  return {
    apiUrl,
    accessToken: value["accessToken"],
    employee: parseEmployee(value["employee"])
  };
}

function parseStoredSession(value: unknown): HubCliSession {
  if (
    !isRecord(value) ||
    typeof value["apiUrl"] !== "string" ||
    typeof value["accessToken"] !== "string"
  ) {
    throw new CliError("Stored CLI session is invalid. Run login again.");
  }

  return {
    apiUrl: normalizeApiUrl(value["apiUrl"]),
    accessToken: value["accessToken"],
    employee: parseEmployee(value["employee"])
  };
}

function parseEmployee(value: unknown): HubCliSession["employee"] {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    typeof value["email"] !== "string" ||
    typeof value["role"] !== "string" ||
    !Array.isArray(value["labels"]) ||
    !value["labels"].every((label) => typeof label === "string")
  ) {
    throw new CliError("Employee payload is invalid.");
  }

  return {
    id: value["id"],
    email: value["email"],
    role: value["role"],
    labels: value["labels"]
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function authorizationHeaders(session: HubCliSession): HeadersInit {
  return {
    authorization: `Bearer ${session.accessToken}`
  };
}

function writeJson(runtime: CliRuntime, value: unknown): void {
  runtime.io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function helpText(): string {
  return [
    "Usage:",
    "  hub login --email <seeded-email>",
    '  hub documents search "保利店 美团"',
    "  hub documents upload <file> --label <labelKey>",
    "",
    "Options:",
    "  --api-url <url>         API base URL, defaults to HUB_API_URL or http://127.0.0.1:3000",
    "  --session-file <path>   Local ignored session file, defaults to .data/hub-cli/session.json"
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
