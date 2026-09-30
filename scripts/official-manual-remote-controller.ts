import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { StructuredWindow } from "./official-manual-acceptance-support.js";

const execFileAsync = promisify(execFile);
const DEFAULT_STAGING_HOST = "39.96.66.185";
const DEFAULT_STAGING_USER = "root";
const STAGING_COMPOSE_FILE = "/opt/smedc/docker-compose.yml";
const STAGING_RUNTIME_ENV_FILE = "/opt/smedc/runtime.env";

export type RemoteControllerCommand = "cleanup" | "window";

export function buildStagingSshArgs(): string[] {
  const sshKeyPath =
    process.env["SMEDC_STAGING_SSH_KEY"] ?? path.join(os.homedir(), ".ssh", "id_ed25519");
  const knownHostsPath = path.join(process.cwd(), "deploy", "staging", "known_hosts");

  return [
    "-i",
    sshKeyPath,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`
  ];
}

export function buildRemoteControllerCommand(
  command: RemoteControllerCommand,
  runId: string
): string[] {
  return [
    "docker",
    "compose",
    "--profile",
    "release",
    "--env-file",
    STAGING_RUNTIME_ENV_FILE,
    "-f",
    STAGING_COMPOSE_FILE,
    "run",
    "-T",
    "--rm",
    "release-ops",
    "node",
    "dist/release/official-manual-acceptance.js",
    `controller-${command}`,
    `--run-id=${runId}`
  ];
}

export async function runStagingController<T>(
  command: RemoteControllerCommand,
  runId: string
): Promise<T> {
  const target = `${
    process.env["SMEDC_STAGING_SSH_USER"] ?? DEFAULT_STAGING_USER
  }@${process.env["SMEDC_STAGING_HOST"] ?? DEFAULT_STAGING_HOST}`;
  const sshArgs = buildStagingSshArgs();
  const { stdout: containerOutput } = await execFileAsync("ssh", [
    ...sshArgs,
    target,
    "docker",
    "ps",
    "--filter",
    "label=com.docker.compose.project=smedc-staging",
    "--filter",
    "label=com.docker.compose.service=api",
    "--filter",
    "health=healthy",
    "--format",
    "{{.Names}}"
  ]);
  const containers = containerOutput
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (containers.length !== 1) {
    throw new Error(`Expected one healthy staging API container; found ${containers.length}.`);
  }

  const { stdout } = await execFileAsync("ssh", [
    ...sshArgs,
    target,
    ...buildRemoteControllerCommand(command, runId)
  ]);
  return JSON.parse(stdout) as T;
}

export interface RemoteWindowResult {
  ok: true;
  command: "controller-window";
  runId: string;
  structuredWindow: StructuredWindow;
}

/** PDF manifests contain identifiers only. stdin avoids quoting private paths or setup secrets. */
export async function runPdfStagingController(
  args: import("./pdf-acceptance-support.js").PdfAcceptanceArgs,
  manifest: import("./pdf-acceptance-support.js").PdfAcceptanceManifest
): Promise<{ ok: boolean; manifest: import("./pdf-acceptance-support.js").PdfAcceptanceManifest }> {
  const { spawn } = await import("node:child_process");
  const { validatePdfAcceptanceManifest } = await import("./pdf-acceptance-support.js");
  validatePdfAcceptanceManifest(manifest);
  const target = `${process.env["SMEDC_STAGING_SSH_USER"] ?? DEFAULT_STAGING_USER}@${process.env["SMEDC_STAGING_HOST"] ?? DEFAULT_STAGING_HOST}`;
  const command = [
    "docker",
    "compose",
    "--profile",
    "release",
    "--env-file",
    STAGING_RUNTIME_ENV_FILE,
    "-f",
    STAGING_COMPOSE_FILE,
    "run",
    "-T",
    "--rm",
    "-e",
    "SMEDC_PDF_ACCEPTANCE_CONTROLLER=1",
    "release-ops",
    "node",
    "dist/release/pdf-acceptance.js",
    args.command,
    "--profile=pdf",
    `--run-id=${args.runId}`,
    `--manifest=/tmp/pdf-acceptance-${args.runId}.json`,
    ...(args.documentId ? [`--document-id=${args.documentId}`] : [])
  ];
  if (args.documentId && !/^[A-Za-z0-9_-]{1,32}$/.test(args.documentId))
    throw new Error("Invalid exact PDF document ID.");
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn("ssh", [...buildStagingSshArgs(), target, ...command], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let output = "";
    let oversized = false;
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 4 * 1024 * 1024) {
        oversized = true;
        child.kill();
      }
    });
    child.stderr.resume(); // Never echo controller exceptions containing runtime details.
    child.on("error", reject);
    child.on("close", () => {
      if (oversized) reject(new Error("PDF controller reply exceeded bound."));
      else resolve(output);
    });
    child.stdin.end(JSON.stringify(manifest));
  });
  const response = JSON.parse(result) as { ok: boolean; manifest: unknown };
  const returned = validatePdfAcceptanceManifest(response.manifest);
  if (returned.runId !== args.runId || typeof response.ok !== "boolean")
    throw new Error("Invalid PDF controller response.");
  return { ok: response.ok, manifest: returned };
}
