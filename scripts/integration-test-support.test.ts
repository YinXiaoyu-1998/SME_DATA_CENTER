import { describe, expect, it } from "vitest";
import { formatCleanupFailures, formatCommandFailure } from "./integration-test-support.js";

describe("integration test cleanup diagnostics", () => {
  it("preserves each underlying cleanup exception in the reported failure", () => {
    const databaseFailure = new Error("ER_LOCK_WAIT_TIMEOUT: run database was locked");
    const qdrantFailure = new Error("Qdrant returned HTTP 503");

    const message = formatCleanupFailures([
      { scope: "run database", error: databaseFailure },
      { scope: "run Qdrant collection", error: qdrantFailure }
    ]);

    expect(message).toContain("run database");
    expect(message).toContain("ER_LOCK_WAIT_TIMEOUT: run database was locked");
    expect(message).toContain("run Qdrant collection");
    expect(message).toContain("Qdrant returned HTTP 503");
  });

  it("includes Docker exit code, signal, stdout, and stderr", () => {
    const message = formatCommandFailure("docker", ["compose", "down", "-v"], {
      exitCode: 17,
      signal: null,
      stdout: "stopped mysql",
      stderr: "network still has active endpoints"
    });

    expect(message).toContain("exit 17");
    expect(message).toContain("stopped mysql");
    expect(message).toContain("network still has active endpoints");
  });
});
