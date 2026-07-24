import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, describe, expect, it } from "vitest";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
let packageDirectory: string;
let tarballPath: string;
let installDirectory: string;
let binaryPath: string;

describe("published launcher artifact", () => {
  beforeAll(async () => {
    packageDirectory = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-pack-"));
    installDirectory = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-install-"));
    exec("npm", ["run", "build", "--workspace", "enterprise-hub-mcp-launcher"]);
    const pack = JSON.parse(
      exec("npm", [
        "pack",
        "--workspace",
        "enterprise-hub-mcp-launcher",
        "--pack-destination",
        packageDirectory,
        "--json"
      ])
    ) as Array<{ filename: string }>;
    tarballPath = path.join(packageDirectory, pack[0]!.filename);
    exec("npm", ["init", "-y"], installDirectory);
    exec("npm", ["install", "--ignore-scripts", tarballPath], installDirectory);
    binaryPath = path.join(
      installDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32"
        ? "enterprise-hub-mcp-launcher.cmd"
        : "enterprise-hub-mcp-launcher"
    );
  }, 60_000);

  it("contains only the publish allowlist and no unpublished workspace dependency", () => {
    const files = exec("tar", ["-tzf", tarballPath]).trim().split("\n").sort();
    expect(files).toEqual([
      "package/LICENSE",
      "package/README.md",
      "package/dist/index.d.ts",
      "package/dist/index.js",
      "package/package.json"
    ]);
    const manifest = JSON.parse(exec("tar", ["-xOf", tarballPath, "package/package.json"])) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).not.toHaveProperty("@enterprise-hub/mcp-contract");
    const declarations = exec("tar", ["-xOf", tarballPath, "package/dist/index.d.ts"]);
    expect(declarations).not.toMatch(/@enterprise-hub\/(?:mcp-contract|domain)/);
  });

  it("passes a built-artifact secret and legacy-contract scan", () => {
    const bundledSource = exec("tar", ["-xOf", tarballPath, "package/dist/index.js"]);
    for (const forbidden of [
      "ENTERPRISE_HUB_API_URL",
      "/auth/dev-login",
      "enterprise_hub_login_local",
      "@enterprise-hub/mcp-contract",
      "exact-access-token",
      "access-secret",
      "refresh-secret",
      "authorization-code"
    ]) {
      expect(bundledSource).not.toContain(forbidden);
    }
  });

  it("installs into an empty directory, reports its version, and emits a CycloneDX SBOM", async () => {
    expect(exec(binaryPath, ["--version"], installDirectory).trim()).toBe("0.1.0");
    const sbom = JSON.parse(
      exec("npm", ["sbom", "--sbom-format", "cyclonedx"], installDirectory)
    ) as { components?: Array<{ name?: string }> };
    expect(
      sbom.components?.some((component) => component.name === "enterprise-hub-mcp-launcher")
    ).toBe(true);
    expect(await readFile(path.join(installDirectory, "package-lock.json"), "utf8")).toContain(
      "enterprise-hub-mcp-launcher"
    );
  });

  it("supports stdio initialize and list-tools from the installed binary", async () => {
    const transport = new StdioClientTransport({
      command: binaryPath,
      args: ["serve"],
      env: {
        ...process.env,
        ENTERPRISE_HUB_BASE_URL: "https://hub.example.test"
      } as Record<string, string>
    });
    const client = new Client({ name: "packaging-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "enterprise_hub_login",
          "enterprise_hub_logout",
          "enterprise_hub_auth_status"
        ])
      );
    } finally {
      await client.close();
    }
  });
});

function exec(command: string, args: string[], cwd = workspaceRoot): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_loglevel: "error" }
  });
}
