import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { LAUNCHER_VERSION } from "./oauth-client.js";
import { MCP_LAUNCHER_SERVER_VERSION } from "./server.js";

describe("launcher CLI entrypoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports the runtime launcher version for --version", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const previousArgv = process.argv;
    process.argv = ["node", "index.js", "--version"];
    try {
      const { runCommand } = await import("./index.js");
      await runCommand();
    } finally {
      process.argv = previousArgv;
    }
    expect(write).toHaveBeenCalledWith(`${LAUNCHER_VERSION}\n`);
  });

  it("keeps the package, protocol server, and runtime release on 0.7.0", () => {
    expect(LAUNCHER_VERSION).toBe("0.7.0");
    expect(MCP_LAUNCHER_SERVER_VERSION).toBe(LAUNCHER_VERSION);
    expect(
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version
    ).toBe(LAUNCHER_VERSION);
  });
});
