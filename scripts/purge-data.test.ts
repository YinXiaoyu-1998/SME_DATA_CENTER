import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolvePurgeTargets } from "./purge-data.js";

describe("purge-data target resolution", () => {
  const cwd = "/workspace/enterprise-hub";

  it("targets local upload and test storage directories by default", () => {
    expect(
      resolvePurgeTargets({
        all: false,
        dryRun: false,
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
