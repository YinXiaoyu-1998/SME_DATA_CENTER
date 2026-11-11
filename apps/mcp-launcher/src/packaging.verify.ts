import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
let packageDirectory: string;
let tarballPath: string;
let installDirectory: string;
let binaryPath: string;

describe("published launcher artifact", () => {
  afterAll(async () => {
    await Promise.all(
      [packageDirectory, installDirectory]
        .filter(Boolean)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });
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
      process.platform === "win32" ? "smedc-mcp-launcher.cmd" : "smedc-mcp-launcher"
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
    expect(manifest.dependencies).toHaveProperty("yauzl", "3.4.0");
    expect(manifest).toMatchObject({
      license: "MIT",
      bin: { "smedc-mcp-launcher": "dist/index.js" },
      repository: {
        url: "git+https://github.com/YinXiaoyu-1998/SME_DATA_CENTER.git",
        directory: "apps/mcp-launcher"
      },
      publishConfig: { access: "public" }
    });
    const declarations = exec("tar", ["-xOf", tarballPath, "package/dist/index.d.ts"]);
    expect(declarations).not.toMatch(
      new RegExp(["@enterprise", "hub/(?:mcp-contract|domain)"].join("-"))
    );
    expect(declarations).not.toMatch(/@smedc\/(?:mcp-contract|domain)/);
  });

  it("derives the platform-acceptance tarball name from npm pack output", async () => {
    const workflow = await readFile(
      path.join(workspaceRoot, ".github", "workflows", "launcher-release.yml"),
      "utf8"
    );
    expect(workflow).not.toMatch(/smedc-mcp-launcher-\d+\.\d+\.\d+\.tgz/);
    expect(workflow).toMatch(/workflow_dispatch:/);
    expect(workflow).toMatch(/push:\s*\n\s*tags:\s*\n\s*- "smedc-mcp-launcher-v\*"/);
    expect(workflow).not.toMatch(/branches:\s*\n\s*- main/);
    expect(workflow).toMatch(/npm pack --workspace smedc-mcp-launcher --json/);
    expect(workflow).toContain("${{ steps.pack.outputs.tarball }}");
    expect(workflow).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(workflow).toContain('if [[ "$GITHUB_REF_TYPE" = "tag" ]]');
    expect(workflow).toContain('test "$GITHUB_REF_NAME" = "main"');
    expect(workflow).toContain('diff -qr "$compare_dir/extracted-registry/package"');
    expect(workflow).toContain('npm view "$package_name" name');
    expect(workflow).toContain("Initial npm package bootstrap required");
    expect(workflow).toContain("npm stage publish");
    expect(workflow).not.toContain("npm publish --workspace");
  });

  it("passes a built-artifact secret and legacy-contract scan", () => {
    const bundledSource = exec("tar", ["-xOf", tarballPath, "package/dist/index.js"]);
    expect(bundledSource).toContain("SMEDC_BASE_URL");
    expect(bundledSource).toContain("Launcher 0.5.0+");
    for (const forbidden of [
      "SMEDC_API_URL",
      ["ENTERPRISE", "HUB", "API", "URL"].join("_"),
      ["ENTERPRISE", "HUB", "BASE", "URL"].join("_"),
      "/auth/dev-login",
      ["enterprise", "hub", "login", "local"].join("_"),
      ["@enterprise", "hub/mcp-contract"].join("-"),
      ["enterprise", "hub", "partition", "extracts"].join("-"),
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
    expect(manifest.version).toBe("0.19.0");
    expect(exec(binaryPath, ["--version"], installDirectory).trim()).toBe(manifest.version);
    const sbom = JSON.parse(
      exec("npm", ["sbom", "--sbom-format", "cyclonedx"], installDirectory)
    ) as { components?: Array<{ name?: string }> };
    expect(sbom.components?.some((component) => component.name === "yauzl")).toBe(true);
    expect(sbom.components?.some((component) => component.name === "smedc-mcp-launcher")).toBe(
      true
    );
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
      expect(client.getServerVersion()?.version).toBe("0.19.0");
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toHaveLength(53);
      expect(new Set(names).size).toBe(53);
      const retiredNames = [
        "list_account_permissions",
        "get_account_permissions",
        "list_business_categories",
        "list_business_dimensions",
        "list_business_stores",
        "create_evidence_category",
        "update_business_category",
        "create_business_dimension",
        "update_business_dimension",
        "create_business_dimension_value",
        "update_business_dimension_value",
        "list_enterprise_workflows",
        "get_enterprise_workflow"
      ];
      for (const name of retiredNames) {
        expect(names).not.toContain(name);
        const result = await client.callTool({ name, arguments: {} });
        expect(result).toMatchObject({
          isError: true,
          content: [{ type: "text", text: expect.stringMatching(/not found|unknown/i) }]
        });
      }
      expect(tools.tools.find((tool) => tool.name === "get_permission_directory")).toMatchObject({
        annotations: { readOnlyHint: true },
        inputSchema: {
          additionalProperties: false,
          required: ["section"],
          properties: { section: { enum: ["categories", "dimensions", "stores"] } }
        }
      });
      const evidenceFields = ["name", "ownerships", "requiredDimensionIds"] as const;
      const dimensionFields = ["dimensionId", "name"] as const;
      const valueFields = [...dimensionFields, "valueId"] as const;
      const branchCases = {
        query_account_permissions: [
          "query",
          [
            ["list", []],
            ["detail", ["userAccountId"]]
          ]
        ],
        query_enterprise_workflows: [
          "query",
          [
            ["list", [], ["enterpriseKey", "cursor", "limit"]],
            ["detail", ["enterpriseKey", "workflowType"]]
          ]
        ],
        configure_business_category: [
          "operation",
          [
            ["create_evidence", ["id", ...evidenceFields], ["retired"]],
            ["update_evidence", ["categoryId", ...evidenceFields], ["retired"]],
            ["update_fixed", ["categoryId", "name", "confidentialityLevel"], ["retired"]]
          ]
        ],
        configure_business_dimension: [
          "operation",
          [
            ["create", dimensionFields, ["retired"]],
            ["update", dimensionFields, ["retired"]]
          ]
        ],
        configure_business_dimension_value: [
          "operation",
          [
            ["create", valueFields, ["retired"]],
            ["update", valueFields, ["retired"]]
          ]
        ]
      } as const;
      type DiscoveryBranch = {
        properties?: Record<string, { const?: string }>;
        required?: string[];
      };
      for (const [name, [selector, expectedBranches]] of Object.entries(branchCases)) {
        const tool = tools.tools.find((tool) => tool.name === name);
        const readOnly = selector === "query";
        const discriminator = readOnly ? "mode" : "kind";
        expect(tool, name).toMatchObject({
          annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly },
          inputSchema: {
            additionalProperties: false,
            required: readOnly ? ["query"] : ["expectedVersion", "operation"]
          }
        });
        const nested = tool?.inputSchema.properties?.[selector] as
          { oneOf?: DiscoveryBranch[]; anyOf?: DiscoveryBranch[] } | undefined;
        const branches = nested?.oneOf ?? nested?.anyOf;
        expect(branches, name).toHaveLength(expectedBranches.length);
        for (const [literal, fields, optional = []] of expectedBranches) {
          const branch = branches?.find(
            (candidate) => candidate.properties?.[discriminator]?.const === literal
          );
          const required = [discriminator, ...fields];
          expect(branch, `${name} ${literal}`).toMatchObject({ additionalProperties: false });
          expect([...branch!.required!].sort()).toEqual(required.sort());
          expect(Object.keys(branch!.properties!).sort()).toEqual(
            [...required, ...optional].sort()
          );
        }
      }
      expect(
        tools.tools.find((tool) => tool.name === "upsert_store_reviews")?.inputSchema
      ).toMatchObject({
        properties: { reviews: { items: { properties: { feedbackId: { type: "string" } } } } }
      });
      expect(
        tools.tools.find((tool) => tool.name === "query_store_reviews")?.inputSchema
      ).toMatchObject({ properties: { feedbackId: { type: "string" } } });
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "smedc_login",
          "smedc_logout",
          "smedc_auth_status",
          "smedc_get_current_user",
          "upsert_dish_catalog",
          "describe_structured_dataset_coverage",
          "prepare_structured_partition_download",
          "get_structured_partition_download_status",
          "download_structured_partitions",
          "download_cost_cards",
          "archive_cost_card",
          "upsert_store_reviews",
          "query_store_reviews",
          "describe_ledger_pdf_coverage",
          "get_ledger_pdf_request_status",
          "prepare_ledger_pdf_download",
          "get_ledger_pdf_download_url",
          "get_my_permissions",
          "query_account_permissions",
          "update_account_permissions",
          "get_permission_directory",
          "configure_business_category",
          "update_evidence_document_attributes",
          "prepare_authorization_cutover",
          "activate_authorization_cutover",
          "suspend_authorization_reads"
        ])
      );
      expect(tools.tools.map((tool) => tool.name)).not.toContain("refresh_ledger_pdfs");
      const removed = await client.callTool({
        name: "refresh_ledger_pdfs",
        arguments: { storeNames: ["店"], dates: ["2026-10-04"], idempotencyKey: "key" }
      });
      expect(removed.isError).toBe(true);
      for (const name of ["prepare_ledger_pdf_download"]) {
        expect(tools.tools.find((tool) => tool.name === name)).toMatchObject({
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: expect.arrayContaining(["storeNames", "idempotencyKey"])
          }
        });
      }
      for (const name of [
        "describe_ledger_pdf_coverage",
        "get_ledger_pdf_request_status",
        "get_ledger_pdf_download_url"
      ])
        expect(tools.tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(
          true
        );
      const structuredUpload = tools.tools.find(
        (tool) => tool.name === "upload_structured_dataset"
      );
      for (const name of [
        "upload_structured_dataset",
        "upload_evidence_document",
        "upload_quarantine_certificate"
      ]) {
        expect(tools.tools.find((tool) => tool.name === name)?.description).toContain(
          "Requires the admin role."
        );
      }
      const structuredUploadSchema = structuredUpload?.inputSchema as {
        type?: string;
        additionalProperties?: boolean;
        properties?: { dataset?: { enum?: string[] } } & Record<string, unknown>;
      };
      const structuredUploadDatasets = structuredUploadSchema.properties?.dataset?.enum;
      expect(structuredUploadDatasets).toEqual(
        expect.arrayContaining(["delivery_ledger", "supplier_catalog", "cost_cards"])
      );
      expect(structuredUploadDatasets).not.toContain("dish_catalog");
      expect(structuredUploadSchema.type).toBe("object");
      expect(structuredUploadSchema.properties).not.toHaveProperty("snapshotDate");
      for (const name of [
        "upload_structured_dataset",
        "describe_structured_dataset_coverage",
        "download_structured_partitions",
        "prepare_structured_partition_download"
      ]) {
        expect(tools.tools.find((tool) => tool.name === name)?.inputSchema, name).toMatchObject({
          type: "object",
          properties: {
            dataset: { enum: expect.arrayContaining(["in_store_orders", "takeaway_orders"]) }
          }
        });
      }
      expect(structuredUpload?.description).toContain("0.15.0+");
      expect(structuredUpload?.inputSchema).toMatchObject({
        properties: {
          file: {
            anyOf: expect.arrayContaining([
              expect.objectContaining({
                properties: expect.objectContaining({
                  encoding: expect.objectContaining({ type: "string", const: "path" }),
                  filePath: expect.objectContaining({ type: "string" })
                })
              })
            ])
          },
          startDate: { type: "string", pattern: "^\\d{8}$" },
          endDate: { type: "string", pattern: "^\\d{8}$" }
        }
      });
      expect(
        tools.tools.find((tool) => tool.name === "get_partition_import_status")?.inputSchema
      ).toMatchObject({
        required: ["partitionImportJobId"],
        properties: { partitionImportJobId: { type: "string" } }
      });
      expect(
        tools.tools.find((tool) => tool.name === "get_structured_partition_download_status")
          ?.inputSchema
      ).toMatchObject({
        required: ["requestId"],
        properties: { requestId: { type: "string" } }
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
