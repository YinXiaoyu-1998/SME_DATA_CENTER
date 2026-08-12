import { afterEach, describe, expect, it, vi } from "vitest";
import { LAUNCHER_VERSION } from "./oauth-client.js";

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
});
