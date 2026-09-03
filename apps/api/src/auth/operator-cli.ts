import { fileURLToPath } from "node:url";
import { createDatabaseAdapter } from "@enterprise-hub/db";
import { PrismaClient } from "@prisma/client";
import type { EmployeeRoleName } from "@enterprise-hub/domain";
import {
  AUTH_LIFETIMES_MS,
  generateOpaqueSecret,
  hashOpaqueSecret,
  normalizeLoginEmail
} from "./primitives.js";
import { createPrismaAuthOperatorRepository } from "./prisma-auth-operator-repository.js";

export type OperatorCommand =
  | {
      kind: "onboard";
      orgId: string;
      email: string;
      displayName: string;
      role: EmployeeRoleName;
      labelKeys: string[];
    }
  | { kind: "reset-password"; employeeId: string }
  | { kind: "delete-test-account"; email: string; confirmEmail: string }
  | { kind: "audit"; days: number; limit: number };

export interface AuthOperatorAuditRow {
  createdAt: Date;
  eventType: string;
  outcome: string;
  reason: string | null;
  requestId: string | null;
  sourceIp: string | null;
  launcherVersion: string | null;
  orgId: string | null;
  identityId: string | null;
  employeeId: string | null;
  sessionId: string | null;
}

export interface AuthOperatorRepository {
  onboard(input: {
    orgId: string;
    normalizedEmail: string;
    displayName: string;
    role: EmployeeRoleName;
    labelKeys: string[];
    grantTokenHash: string;
    grantExpiresAt: Date;
    now: Date;
  }): Promise<{ employeeId: string; identityId: string }>;
  resetPassword(input: {
    employeeId: string;
    grantTokenHash: string;
    grantExpiresAt: Date;
    now: Date;
  }): Promise<{ employeeId: string; identityId: string } | null>;
  deleteTestAccount(input: { normalizedEmail: string; now: Date }): Promise<{
    employeeId: string;
    identityIds: string[];
    personalLabelDeleted: boolean;
  } | null>;
  audit(input: { since: Date; limit: number }): Promise<AuthOperatorAuditRow[]>;
  disconnect?(): Promise<void>;
}

function parseOptions(
  args: string[],
  allowed: ReadonlySet<string>,
  repeatable: ReadonlySet<string> = new Set()
): Map<string, string[]> {
  const options = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option?.startsWith("--") || !allowed.has(option)) {
      throw new Error(`Unknown option: ${option ?? ""}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${option}`);
    }
    if (!repeatable.has(option) && options.has(option)) {
      throw new Error(`Duplicate option: ${option}`);
    }
    options.set(option, [...(options.get(option) ?? []), value]);
  }
  return options;
}

function required(options: Map<string, string[]>, name: string): string {
  const value = options.get(name)?.[0];
  if (!value) {
    throw new Error(`Missing required option: ${name}`);
  }
  return value;
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
) {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Expected an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

export function parseOperatorCommand(args: string[]): OperatorCommand {
  const [subcommand, ...rest] = args;
  if (subcommand === "onboard") {
    const options = parseOptions(
      rest,
      new Set(["--org-id", "--email", "--display-name", "--role", "--label"]),
      new Set(["--label"])
    );
    const role = required(options, "--role");
    if (!["admin", "manager", "employee"].includes(role)) {
      throw new Error("Role must be admin, manager, or employee.");
    }
    return {
      kind: "onboard",
      orgId: required(options, "--org-id"),
      email: required(options, "--email"),
      displayName: required(options, "--display-name"),
      role: role as EmployeeRoleName,
      labelKeys: options.get("--label") ?? []
    };
  }
  if (subcommand === "reset-password") {
    const options = parseOptions(rest, new Set(["--employee-id"]));
    return {
      kind: "reset-password",
      employeeId: required(options, "--employee-id")
    };
  }
  if (subcommand === "delete-test-account") {
    const options = parseOptions(rest, new Set(["--email", "--confirm-email"]));
    const email = required(options, "--email");
    const confirmEmail = required(options, "--confirm-email");
    if (normalizeLoginEmail(email) !== normalizeLoginEmail(confirmEmail)) {
      throw new Error("--confirm-email must exactly match --email after login normalization.");
    }
    if (!isSyntheticManualTestEmail(email)) {
      throw new Error(
        "delete-test-account only accepts manual-acceptance-* or manual-full-flow-* @example.invalid test emails."
      );
    }
    return {
      kind: "delete-test-account",
      email,
      confirmEmail
    };
  }
  if (subcommand === "audit") {
    const options = parseOptions(rest, new Set(["--days", "--limit"]));
    return {
      kind: "audit",
      days: boundedInteger(options.get("--days")?.[0], 30, 1, 90),
      limit: boundedInteger(options.get("--limit")?.[0], 100, 1, 1_000)
    };
  }
  throw new Error("Expected onboard, reset-password, delete-test-account, or audit.");
}

export async function runOperatorCommand(
  command: OperatorCommand,
  dependencies: {
    repository: AuthOperatorRepository;
    publicOrigin: string;
    stdout: (line: string) => void;
    now?: () => Date;
  }
): Promise<void> {
  const now = dependencies.now?.() ?? new Date();
  if (command.kind === "audit") {
    const rows = await dependencies.repository.audit({
      since: new Date(now.getTime() - command.days * 24 * 60 * 60_000),
      limit: command.limit
    });
    dependencies.stdout(JSON.stringify(rows));
    return;
  }
  if (command.kind === "delete-test-account") {
    const result = await dependencies.repository.deleteTestAccount({
      normalizedEmail: normalizeLoginEmail(command.email),
      now
    });
    dependencies.stdout(
      JSON.stringify({
        ok: true,
        deleted: result !== null,
        employeeId: result?.employeeId ?? null,
        identityCount: result?.identityIds.length ?? 0,
        personalLabelDeleted: result?.personalLabelDeleted ?? false
      })
    );
    return;
  }

  const origin = new URL(dependencies.publicOrigin);
  if (origin.protocol !== "https:") {
    throw new Error("ENTERPRISE_HUB_PUBLIC_ORIGIN must use HTTPS.");
  }
  const secret = generateOpaqueSecret("eh_ps_");
  const grantInput = {
    grantTokenHash: hashOpaqueSecret(secret),
    grantExpiresAt: new Date(now.getTime() + AUTH_LIFETIMES_MS.passwordSetupGrant),
    now
  };

  const result =
    command.kind === "onboard"
      ? await dependencies.repository.onboard({
          orgId: command.orgId,
          normalizedEmail: normalizeLoginEmail(command.email),
          displayName: command.displayName,
          role: command.role,
          labelKeys: [...new Set(command.labelKeys)],
          ...grantInput
        })
      : await dependencies.repository.resetPassword({
          employeeId: command.employeeId,
          ...grantInput
        });
  if (!result) {
    throw new Error("Employee does not have an active local-password Login Identity.");
  }

  const setupUrl = new URL("/auth/password/setup", origin);
  setupUrl.hash = `token=${secret}`;
  dependencies.stdout(setupUrl.toString());
}

function isSyntheticManualTestEmail(email: string): boolean {
  const normalized = normalizeLoginEmail(email);
  return (
    normalized.endsWith("@example.invalid") &&
    (normalized.startsWith("manual-acceptance-") || normalized.startsWith("manual-full-flow-"))
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  const publicOrigin = process.env["ENTERPRISE_HUB_PUBLIC_ORIGIN"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }
  if (!publicOrigin) {
    throw new Error("ENTERPRISE_HUB_PUBLIC_ORIGIN is required.");
  }
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
  const repository = createPrismaAuthOperatorRepository(prisma);
  try {
    await runOperatorCommand(parseOperatorCommand(process.argv.slice(2)), {
      repository,
      publicOrigin,
      stdout: (line) => process.stdout.write(`${line}\n`)
    });
  } finally {
    await repository.disconnect?.();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Auth operator command failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
