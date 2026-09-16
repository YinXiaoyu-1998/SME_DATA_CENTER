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
    packageDirectory = await mkdtemp(path.join(os.tmpdir(), "smedc-pack-"));
    installDirectory = await mkdtemp(path.join(os.tmpdir(), "smedc-install-"));
    exec("npm", ["run", "build", "--workspace", "smedc-mcp-launcher"]);
    const pack = JSON.parse(
      exec("npm", [
        "pack",
        "--workspace",
        "smedc-mcp-launcher",
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
        ? "smedc-mcp-launcher.cmd"
        : "smedc-mcp-launcher"
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
      bin?: Record<string, string>;
      license?: string;
      repository?: { url?: string; directory?: string };
      publishConfig?: { access?: string };
    };
    expect(manifest.dependencies).not.toHaveProperty("@smedc/mcp-contract");
    expect(manifest).toMatchObject({
      license: "MIT",
      bin: { "smedc-mcp-launcher": "dist/index.js" },
      repository: {
        url: "git+https://github.com/YinXiaoyu-1998/smedc.git",
        directory: "apps/mcp-launcher"
      },
      publishConfig: { access: "public" }
    });
    const declarations = exec("tar", ["-xOf", tarballPath, "package/dist/index.d.ts"]);
    expect(declarations).not.toMatch(/@enterprise-hub\/(?:mcp-contract|domain)/);
    expect(declarations).not.toMatch(/@smedc\/(?:mcp-contract|domain)/);
  });

  it("derives the platform-acceptance tarball name from npm pack output", async () => {
    const workflow = await readFile(
      path.join(workspaceRoot, ".github", "workflows", "launcher-release.yml"),
      "utf8"
    );
    expect(workflow).not.toMatch(/smedc-mcp-launcher-\d+\.\d+\.\d+\.tgz/);
    expect(workflow).toMatch(/branches:\s*\n\s*- main/);
    expect(workflow).toMatch(/npm pack --workspace smedc-mcp-launcher --json/);
    expect(workflow).toContain("${{ steps.pack.outputs.tarball }}");
    expect(workflow).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(workflow).toContain('if [[ "$GITHUB_REF_TYPE" = "tag" ]]');
    expect(workflow).toContain('diff -qr "$compare_dir/extracted-registry/package"');
    expect(workflow).toContain("npm stage publish");
    expect(workflow).not.toContain("npm publish --workspace");
  });

  it("passes a built-artifact secret and legacy-contract scan", () => {
    const bundledSource = exec("tar", ["-xOf", tarballPath, "package/dist/index.js"]);
    expect(bundledSource).toContain("SMEDC_BASE_URL");
    for (const forbidden of [
      "SMEDC_API_URL",
      ["ENTERPRISE", "HUB", "API", "URL"].join("_"),
      ["ENTERPRISE", "HUB", "BASE", "URL"].join("_"),
      "/auth/dev-login",
      ["enterprise", "hub", "login", "local"].join("_"),
      ["@enterprise", "hub/mcp-contract"].join("-"),
      "exact-access-token",
      "access-secret",
      "refresh-secret",
      "authorization-code"
    ]) {
      expect(bundledSource).not.toContain(forbidden);
    }
  });

  it("installs into an empty directory, reports its version, and emits a CycloneDX SBOM", async () => {
    const manifest = JSON.parse(exec("tar", ["-xOf", tarballPath, "package/package.json"])) as {
      version?: string;
    };
    expect(manifest.version).toBe("0.5.0");
    expect(exec(binaryPath, ["--version"], installDirectory).trim()).toBe(manifest.version);
    const sbom = JSON.parse(
      exec("npm", ["sbom", "--sbom-format", "cyclonedx"], installDirectory)
    ) as { components?: Array<{ name?: string }> };
    expect(
      sbom.components?.some((component) => component.name === "smedc-mcp-launcher")
    ).toBe(true);
    expect(await readFile(path.join(installDirectory, "package-lock.json"), "utf8")).toContain(
      "smedc-mcp-launcher"
    );
  });

  it("supports stdio initialize and list-tools from the installed binary", async () => {
    const transport = new StdioClientTransport({
      command: binaryPath,
      args: ["serve"],
      env: {
        ...process.env,
        SMEDC_BASE_URL: "https://hub.example.test"
      } as Record<string, string>
    });
    const client = new Client({ name: "packaging-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "smedc_login",
          "smedc_logout",
          "smedc_auth_status",
          "smedc_get_current_user",
          "describe_structured_dataset_coverage"
        ])
      );
      const structuredUpload = tools.tools.find(
        (tool) => tool.name === "upload_structured_dataset"
      );
      expect(structuredUpload?.inputSchema).toMatchObject({
        type: "object",
        properties: {
          dataset: {
            enum: expect.arrayContaining(["dish_catalog", "delivery_ledger", "supplier_catalog"])
          },
          snapshotDate: { type: "string" }
        }
      });
      expect(structuredUpload?.inputSchema.required).not.toEqual(
        expect.arrayContaining(["startDate", "endDate", "snapshotDate"])
      );
      const structuredQuery = tools.tools.find((tool) => tool.name === "query_structured_dataset");
      expect(structuredQuery?.inputSchema).toMatchObject({
        properties: {
          dataset: {
            enum: expect.arrayContaining(["dish_catalog", "delivery_ledger", "supplier_catalog"])
          }
        }
      });
      const aggregateBranches = (
        structuredQuery?.inputSchema as {
          properties?: {
            aggregates?: {
              items?: {
                oneOf?: Array<{
                  properties?: { op?: { const?: string } };
                  required?: string[];
                }>;
              };
            };
          };
        }
      ).properties?.aggregates?.items?.oneOf;
      const weightedAverageAggregate = aggregateBranches?.find(
        (branch) => branch.properties?.op?.const === "weightedAvg"
      );
      expect(weightedAverageAggregate).toMatchObject({
        properties: {
          field: { type: "string" },
          weightField: { type: "string" }
        },
        required: expect.arrayContaining(["op", "field", "weightField"])
      });
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
