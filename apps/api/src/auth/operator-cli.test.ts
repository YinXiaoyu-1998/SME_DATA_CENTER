import { describe, expect, it } from "vitest";
import {
  parseOperatorCommand,
  runOperatorCommand,
  type AuthOperatorRepository
} from "./operator-cli.js";
import { hashOpaqueSecret } from "./primitives.js";

class MemoryOperatorRepository implements AuthOperatorRepository {
  onboardInput: Parameters<AuthOperatorRepository["onboard"]>[0] | null = null;
  resetInput: Parameters<AuthOperatorRepository["resetPassword"]>[0] | null = null;
  deleteInput: Parameters<AuthOperatorRepository["deleteTestAccount"]>[0] | null = null;

  async onboard(input: Parameters<AuthOperatorRepository["onboard"]>[0]) {
    this.onboardInput = input;
    return { employeeId: "employee-new", identityId: "identity-new" };
  }

  async resetPassword(input: Parameters<AuthOperatorRepository["resetPassword"]>[0]) {
    this.resetInput = input;
    return { employeeId: input.employeeId, identityId: "identity-new" };
  }

  async deleteTestAccount(input: Parameters<AuthOperatorRepository["deleteTestAccount"]>[0]) {
    this.deleteInput = input;
    return {
      employeeId: "employee-new",
      identityIds: ["identity-new"],
      personalLabelDeleted: true
    };
  }

  async audit() {
    return [
      {
        createdAt: new Date("2026-07-24T00:00:00.000Z"),
        eventType: "logout",
        outcome: "succeeded",
        reason: null,
        requestId: null,
        sourceIp: null,
        launcherVersion: null,
        orgId: "org-1",
        identityId: "identity-new",
        employeeId: "employee-new",
        sessionId: "session-1"
      }
    ];
  }
}

describe("auth operator CLI", () => {
  it("parses onboarding including repeated labels and never defines password/token arguments", () => {
    expect(
      parseOperatorCommand([
        "onboard",
        "--org-id",
        "org-1",
        "--email",
        " Person@Example.COM ",
        "--display-name",
        "Person",
        "--role",
        "manager",
        "--label",
        "store:a",
        "--label",
        "all_staff"
      ])
    ).toEqual({
      kind: "onboard",
      orgId: "org-1",
      email: " Person@Example.COM ",
      displayName: "Person",
      role: "manager",
      labelKeys: ["store:a", "all_staff"]
    });

    expect(() =>
      parseOperatorCommand(["reset-password", "--employee-id", "employee-new", "--password", "x"])
    ).toThrow("Unknown option");
    expect(() =>
      parseOperatorCommand(["reset-password", "--employee-id", "employee-new", "--token", "x"])
    ).toThrow("Unknown option");
    expect(() =>
      parseOperatorCommand([
        "delete-test-account",
        "--email",
        "manual-full-flow-1@example.invalid",
        "--confirm-email",
        "manual-full-flow-1@example.invalid",
        "--password",
        "x"
      ])
    ).toThrow("Unknown option");
  });

  it("atomically onboards with normalized email and prints the setup link once", async () => {
    const repository = new MemoryOperatorRepository();
    const stdout: string[] = [];

    await runOperatorCommand(
      {
        kind: "onboard",
        orgId: "org-1",
        email: " Person@Example.COM ",
        displayName: "Person",
        role: "employee",
        labelKeys: []
      },
      {
        repository,
        publicOrigin: "https://api.example.com",
        stdout: (line) => stdout.push(line),
        now: () => new Date("2026-07-24T00:00:00.000Z")
      }
    );

    expect(stdout).toHaveLength(1);
    const setupUrl = new URL(stdout[0]!);
    expect(setupUrl.pathname).toBe("/auth/password/setup");
    const rawSecret = setupUrl.hash.replace("#token=", "");
    expect(rawSecret).toMatch(/^eh_ps_/);
    expect(repository.onboardInput).toMatchObject({
      orgId: "org-1",
      normalizedEmail: "person@example.com",
      displayName: "Person",
      role: "employee"
    });
    expect(repository.onboardInput?.grantTokenHash).toBe(hashOpaqueSecret(rawSecret));
    expect(JSON.stringify(repository.onboardInput)).not.toContain(rawSecret);
    expect(repository.onboardInput).not.toHaveProperty("requestId");
    expect(repository.onboardInput).not.toHaveProperty("sourceIp");
    expect(repository.onboardInput).not.toHaveProperty("launcherVersion");
  });

  it("resets by employee id and persists no raw setup secret", async () => {
    const repository = new MemoryOperatorRepository();
    const stdout: string[] = [];

    await runOperatorCommand(
      { kind: "reset-password", employeeId: "employee-new" },
      {
        repository,
        publicOrigin: "https://api.example.com",
        stdout: (line) => stdout.push(line)
      }
    );

    expect(stdout).toHaveLength(1);
    const rawSecret = new URL(stdout[0]!).hash.replace("#token=", "");
    expect(repository.resetInput?.grantTokenHash).toBe(hashOpaqueSecret(rawSecret));
    expect(JSON.stringify(repository.resetInput)).not.toContain(rawSecret);
    expect(repository.resetInput).not.toHaveProperty("requestId");
    expect(repository.resetInput).not.toHaveProperty("sourceIp");
    expect(repository.resetInput).not.toHaveProperty("launcherVersion");
  });

  it("deletes only confirmed synthetic manual test accounts", async () => {
    const repository = new MemoryOperatorRepository();
    const stdout: string[] = [];

    await runOperatorCommand(
      {
        kind: "delete-test-account",
        email: " Manual-Full-Flow-1@Example.Invalid ",
        confirmEmail: "manual-full-flow-1@example.invalid"
      },
      {
        repository,
        publicOrigin: "https://api.example.com",
        stdout: (line) => stdout.push(line),
        now: () => new Date("2026-07-30T00:00:00.000Z")
      }
    );

    expect(repository.deleteInput).toMatchObject({
      normalizedEmail: "manual-full-flow-1@example.invalid"
    });
    expect(repository.deleteInput).not.toHaveProperty("requestId");
    expect(repository.deleteInput).not.toHaveProperty("sourceIp");
    expect(repository.deleteInput).not.toHaveProperty("launcherVersion");
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      ok: true,
      deleted: true,
      employeeId: "employee-new",
      identityCount: 1,
      personalLabelDeleted: true
    });

    expect(() =>
      parseOperatorCommand([
        "delete-test-account",
        "--email",
        "real@example.com",
        "--confirm-email",
        "real@example.com"
      ])
    ).toThrow("only accepts");
    expect(() =>
      parseOperatorCommand([
        "delete-test-account",
        "--email",
        "manual-full-flow-1@example.invalid",
        "--confirm-email",
        "manual-full-flow-2@example.invalid"
      ])
    ).toThrow("confirm-email");
  });

  it("prints bounded credential-free audit rows", async () => {
    const repository = new MemoryOperatorRepository();
    const stdout: string[] = [];

    await runOperatorCommand(
      { kind: "audit", days: 7, limit: 25 },
      {
        repository,
        publicOrigin: "https://api.example.com",
        stdout: (line) => stdout.push(line),
        now: () => new Date("2026-07-24T00:00:00.000Z")
      }
    );

    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain('"eventType":"logout"');
    expect(stdout[0]).not.toMatch(/password|token|credential|codeHash/i);
  });
});
