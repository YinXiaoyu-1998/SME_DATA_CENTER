import { describe, expect, it, vi } from "vitest";

describe("internal permissions operator CLI", () => {
  it("plans a first-store save with its explicit business name without a separate declaration", async () => {
    const { planPermissionChange } = await import("./cli.js");
    expect(
      planPermissionChange("store.set", { enterpriseName: "Fresh Cafe", name: "First store" }, "7")
    ).toEqual({
      method: "POST",
      url: "/internal/permissions/stores",
      body: { enterpriseName: "Fresh Cafe", name: "First store", expectedVersion: "7" }
    });
  });
  it("requires an explicit tenant, requesting admin, operator and change reference", async () => {
    const cli = await import("./cli.js");
    expect(() => cli.parsePermissionsOperatorArgs(["apply"])).toThrow();
    expect(() => cli.parsePermissionsOperatorArgs(["inspect", "--org-id", "org"])).toThrow();
    expect(() =>
      cli.parsePermissionsOperatorArgs([
        "inspect",
        "--org-id",
        "org",
        "--requested-by-admin-id",
        "admin",
        "--org-id",
        "other"
      ])
    ).toThrow();
    expect(cli.parsePermissionsOperatorArgs(["--help"])).toEqual({ kind: "help" });
  });

  it("allows only named configuration operations and never accepts actor/tenant/version overrides", async () => {
    const { planPermissionChange } = await import("./cli.js");
    expect(
      planPermissionChange("account.set", { employeeId: "target", clearance: 1, grants: [] }, "7")
    ).toEqual({
      method: "PATCH",
      url: "/internal/permissions/accounts/target",
      body: { clearance: 1, grants: [], expectedVersion: "7" }
    });
    expect(() => planPermissionChange("cutover.activate", {}, "7")).toThrow();
    expect(() =>
      planPermissionChange(
        "account.set",
        { employeeId: "target", clearance: 1, grants: [], orgId: "other" },
        "7"
      )
    ).toThrow();
    expect(() =>
      planPermissionChange("document.set", { documentId: "doc", expectedVersion: "2" }, "7")
    ).toThrow();
    expect(() =>
      planPermissionChange("category.update", { id: "../accounts/target", name: "x" }, "7")
    ).toThrow();
  });

  it("previews by default, executes once only when requested and closes even after a conflict", async () => {
    const cli = await import("./cli.js");
    const args = [
      "apply",
      "--org-id",
      "org",
      "--requested-by-admin-id",
      "admin",
      "--operator-id",
      "developer",
      "--reason",
      "Admin requested store retirement",
      "--request-reference",
      "request-1",
      "--expected-version",
      "7",
      "--operation",
      "store.set",
      "--input",
      "-"
    ];
    const runtime = {
      inspect: vi.fn(async () => ({ authorizationVersion: "7", mode: "legacy" })),
      apply: vi.fn(async () => ({ authorizationVersion: "8" })),
      close: vi.fn(async () => {})
    };
    const stdout = vi.fn();
    const dependencies = {
      open: vi.fn(async () => runtime),
      readInput: vi.fn(async () => ({ enterpriseKey: "enterprise", name: "A ", retired: true })),
      stdout
    };
    await cli.runPermissionsOperator(cli.parsePermissionsOperatorArgs(args), dependencies);
    expect(runtime.apply).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({
      dryRun: true,
      change: { body: { name: "A ", retired: true } }
    });
    await cli.runPermissionsOperator(
      cli.parsePermissionsOperatorArgs([...args, "--execute"]),
      dependencies
    );
    expect(runtime.apply).toHaveBeenCalledTimes(1);
    expect(runtime.close).toHaveBeenCalledTimes(2);
    runtime.inspect.mockResolvedValueOnce({ authorizationVersion: "8", mode: "legacy" });
    await expect(
      cli.runPermissionsOperator(
        cli.parsePermissionsOperatorArgs([...args, "--execute"]),
        dependencies
      )
    ).rejects.toThrow("AUTHORIZATION_VERSION_CONFLICT");
    expect(runtime.apply).toHaveBeenCalledTimes(1);
    expect(runtime.close).toHaveBeenCalledTimes(3);
  });
  it("stops before dispatch if interrupted while reading current configuration", async () => {
    const cli = await import("./cli.js");
    let interrupted = false;
    const runtime = {
      inspect: vi.fn(async () => {
        interrupted = true;
        return { authorizationVersion: "7" };
      }),
      apply: vi.fn(),
      close: vi.fn(async () => {})
    };
    const command = cli.parsePermissionsOperatorArgs([
      "apply",
      "--org-id",
      "org",
      "--requested-by-admin-id",
      "admin",
      "--operator-id",
      "developer",
      "--reason",
      "Requested change",
      "--request-reference",
      "request-1",
      "--expected-version",
      "7",
      "--operation",
      "store.set",
      "--input",
      "-",
      "--execute"
    ]);
    await expect(
      cli.runPermissionsOperator(command, {
        open: async () => runtime,
        readInput: async () => ({ enterpriseKey: "enterprise", name: "A" }),
        stdout: vi.fn(),
        interrupted: () => interrupted
      })
    ).rejects.toThrow("OPERATOR_INTERRUPTED");
    expect(runtime.apply).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledOnce();
  });
});
