import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveLocalDatabaseTarget, resolvePurgeTargets } from "./purge-data.js";

describe("purge-data target resolution", () => {
  const cwd = "/workspace/enterprise-hub";

  it("targets local upload and test storage directories by default", () => {
    expect(
      resolvePurgeTargets({
        all: false,
        dryRun: false,
        filesOnly: false,
        cwd,
        env: {}
      })
    ).toEqual([
      { label: "local upload storage", path: path.join(cwd, ".data", "storage") },
      {
        label: "integration test storage",
        path: path.join(cwd, ".data", "integration", "storage")
      },
      {
        label: "MCP smoke test storage",
        path: path.join(cwd, ".data", "mcp-local-test", "storage")
      }
    ]);
  });

  it("can target the full ignored local data directory", () => {
    expect(
      resolvePurgeTargets({
        all: true,
        dryRun: false,
        filesOnly: false,
        cwd,
        env: {}
      })
    ).toEqual([{ label: "all local .data files", path: path.join(cwd, ".data") }]);
  });

  it("skips a storage root outside the repo .data directory", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(
      resolvePurgeTargets({
        all: false,
        dryRun: false,
        filesOnly: false,
        cwd,
        env: {
          LOCAL_STORAGE_ROOT: "/tmp/enterprise-hub-storage"
        }
      })
    ).toEqual([
      {
        label: "integration test storage",
        path: path.join(cwd, ".data", "integration", "storage")
      },
      {
        label: "MCP smoke test storage",
        path: path.join(cwd, ".data", "mcp-local-test", "storage")
      }
    ]);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipping local upload storage")
    );
    stderrSpy.mockRestore();
  });
});

describe("purge-data database target resolution", () => {
  it("accepts the local development MySQL database", () => {
    expect(
      resolveLocalDatabaseTarget({
        DATABASE_URL:
          "mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub"
      })
    ).toEqual({
      databaseUrl:
        "mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub",
      host: "localhost:3307",
      databaseName: "enterprise_hub"
    });
  });

  it("returns null when DATABASE_URL is missing", () => {
    expect(resolveLocalDatabaseTarget({})).toBeNull();
  });

  it("refuses to target a remote database host", () => {
    expect(() =>
      resolveLocalDatabaseTarget({
        DATABASE_URL: "mysql://enterprise_hub:password@example.com:3306/enterprise_hub"
      })
    ).toThrow("non-local DATABASE_URL host");
  });

  it("refuses to target a database with an unexpected name", () => {
    expect(() =>
      resolveLocalDatabaseTarget({
        DATABASE_URL: "mysql://enterprise_hub:password@localhost:3306/production_hub"
      })
    ).toThrow("database other than enterprise_hub");
  });
});
