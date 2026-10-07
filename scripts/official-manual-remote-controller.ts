import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  validateAcceptanceScope,
  type AcceptanceScope,
  type StructuredWindow
} from "./official-manual-acceptance-support.js";

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
  runId: string,
  scope: AcceptanceScope = { documentIds: [], partitionJobIds: [] }
): string[] {
  validateAcceptanceScope(scope);
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(runId)) throw new Error("Invalid acceptance run ID.");
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
    `--run-id=${runId}`,
    ...(scope.reuseSession ? [`--reuse-session=${scope.reuseSession}`] : []),
    ...scope.documentIds.map((id) => `--document-id=${id}`),
    ...scope.partitionJobIds.map((id) => `--partition-job-id=${id}`),
    ...(scope.ledgerRequestIds ?? []).map((id) => `--ledger-request-id=${id}`)
  ];
}

export async function runStagingController<T>(
  command: RemoteControllerCommand,
  runId: string,
  scope?: AcceptanceScope
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
    ...buildRemoteControllerCommand(command, runId, scope)
  ]);
  return JSON.parse(stdout) as T;
}

export interface RemoteWindowResult {
  ok: true;
  command: "controller-window";
  runId: string;
  structuredWindow: StructuredWindow;
}
