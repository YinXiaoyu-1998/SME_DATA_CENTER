import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { assertLauncherVersionOutput, EXPECTED_MCP_LAUNCHER_VERSION } from "./test-mcp-local.js";

const execFileAsync = promisify(execFile);

describe("local MCP smoke launcher version contract", () => {
  it("pins the root launcher smoke to the SMEDC 0.5.1 launcher", () => {
    expect(EXPECTED_MCP_LAUNCHER_VERSION).toBe("0.5.1");
    expect(() => assertLauncherVersionOutput("0.5.1\n")).not.toThrow();
  });

  it("forwards root mcp:launcher arguments to the workspace launcher version command", async () => {
    const { stdout } = await execFileAsync(
      "npm",
      ["run", "--silent", "mcp:launcher", "--", "--version"],
      { cwd: process.cwd() }
    );

    expect(stdout.trim()).toBe(EXPECTED_MCP_LAUNCHER_VERSION);
  });

  it("rejects the previous launcher version without running the live smoke", () => {
    expect(() => assertLauncherVersionOutput("0.4.0\n")).toThrow(
      "mcp:launcher should invoke the official launcher CLI at 0.5.1."
    );
  });
});
