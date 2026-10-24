import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface CommandResult {
  stdout: string;
  stderr: string;
}

const rootDir = process.cwd();
// This smoke executes the workspace candidate. Published installation pins are separate.
export const EXPECTED_MCP_LAUNCHER_VERSION = "0.13.1";

async function main(): Promise<void> {
  try {
    await assertRootLauncherScript();
    await run("npx", [
      "vitest",
      "run",
      "apps/api/src/mcp/http.test.ts",
      "apps/mcp-launcher/src/launcher.test.ts",
      "packages/mcp-contract/src/index.test.ts",
      "apps/api/src/mcp/upload-tools.test.ts",
      "apps/api/src/mcp/read-tools.test.ts",
      "apps/api/src/mcp/action-tools.test.ts",
      "apps/mcp-launcher/src/cost-card-transfer.test.ts",
      "apps/api/src/routes/cost-cards.test.ts",
      "apps/api/src/routes/ledger-pdfs.test.ts"
    ]);

    console.log(
      JSON.stringify(
        {
          ok: true,
          proved: [
            "root_mcp_launcher_script",
            "api_http_post_mcp_endpoint",
            "launcher_stdio_to_http_proxy",
            "mcp_current_authenticated_user",
            "mcp_partition_import_and_download_contracts",
            "mcp_cost_card_directory_download_archive_contracts",
            "mcp_delivery_supplier_contract_and_delegation",
            "mcp_ledger_pdf_tools_and_authenticated_routes"
          ]
        },
        null,
        2
      )
    );
  } catch (error: unknown) {
    console.error(errorToMessage(error));
    process.exitCode = 1;
  }
}

async function run(
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    rejectOnFailure?: boolean;
  } = {}
): Promise<CommandResult> {
  const rejectOnFailure = options.rejectOnFailure ?? true;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { stdout, stderr };

      if (code !== 0 && rejectOnFailure) {
        reject(new Error(commandFailureMessage(command, args, code, result)));
        return;
      }

      resolve(result);
    });
  });
}

async function assertRootLauncherScript(): Promise<void> {
  const packageJson = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = packageJson.scripts ?? {};

  assert(
    scripts["mcp:launcher"] === "npm --workspace smedc-mcp-launcher run --silent start --",
    "Root package.json must expose mcp:launcher through the launcher workspace."
  );

  const launcherVersion = await run("npm", ["run", "--silent", "mcp:launcher", "--", "--version"]);

  assertLauncherVersionOutput(launcherVersion.stdout);
}

export function assertLauncherVersionOutput(stdout: string): void {
  assert(
    stdout.trim() === EXPECTED_MCP_LAUNCHER_VERSION,
    `mcp:launcher should invoke the local launcher candidate at ${EXPECTED_MCP_LAUNCHER_VERSION}.`
  );
}

function commandFailureMessage(
  command: string,
  args: string[],
  code: number | null,
  result: CommandResult
): string {
  return [
    `Command failed (${code ?? "signal"}): ${command} ${args.join(" ")}`,
    result.stdout ? `stdout:\n${result.stdout}` : "",
    result.stderr ? `stderr:\n${result.stderr}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
