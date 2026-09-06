import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

interface CommandResult {
  stdout: string;
  stderr: string;
}

const rootDir = process.cwd();

try {
  await assertRootLauncherScript();
  await run("npx", [
    "vitest",
    "run",
    "apps/api/src/mcp/http.test.ts",
    "apps/mcp-launcher/src/launcher.test.ts",
    "packages/mcp-contract/src/index.test.ts",
    "apps/api/src/mcp/upload-tools.test.ts",
    "apps/api/src/mcp/read-tools.test.ts"
  ]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        proved: [
          "root_mcp_launcher_script",
          "api_http_post_mcp_endpoint",
          "launcher_stdio_to_http_proxy",
          "mcp_structured_pending_status",
          "mcp_delivery_supplier_contract_and_delegation"
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
    scripts["mcp:launcher"] === "npm --workspace enterprise-hub-mcp-launcher run --silent start",
    "Root package.json must expose mcp:launcher through the launcher workspace."
  );

  const launcherVersion = await run("npm", [
    "run",
    "--silent",
    "mcp:launcher",
    "--",
    "--",
    "--version"
  ]);

  assert(
    launcherVersion.stdout.trim() === "0.2.6",
    "mcp:launcher should invoke the official launcher CLI at the expected pinned version."
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
