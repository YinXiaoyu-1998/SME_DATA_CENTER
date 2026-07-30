import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { StructuredWindow } from "./official-manual-acceptance-support.js";

const execFileAsync = promisify(execFile);
const DEFAULT_STAGING_HOST = "39.96.66.185";
const DEFAULT_STAGING_USER = "root";

export type RemoteControllerCommand = "cleanup" | "window";

export function buildStagingSshArgs(): string[] {
  const sshKeyPath =
    process.env["ENTERPRISE_HUB_STAGING_SSH_KEY"] ?? path.join(os.homedir(), ".ssh", "id_ed25519");
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
  containerName: string,
  command: RemoteControllerCommand,
  runId: string
): string[] {
  return [
    "docker",
    "exec",
    "-w",
    "/tmp",
    containerName,
    "/app/node_modules/.bin/tsx",
    "/app/scripts/official-manual-acceptance.ts",
    `controller-${command}`,
    `--run-id=${runId}`
  ];
}

export async function runStagingController<T>(
  command: RemoteControllerCommand,
  runId: string
): Promise<T> {
  const target = `${
    process.env["ENTERPRISE_HUB_STAGING_SSH_USER"] ?? DEFAULT_STAGING_USER
  }@${process.env["ENTERPRISE_HUB_STAGING_HOST"] ?? DEFAULT_STAGING_HOST}`;
  const sshArgs = buildStagingSshArgs();
  const { stdout: containerOutput } = await execFileAsync("ssh", [
    ...sshArgs,
    target,
    "docker",
    "ps",
    "--filter",
    "label=com.docker.compose.project=enterprise-hub-staging",
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
    ...buildRemoteControllerCommand(containers[0]!, command, runId)
  ]);
  return JSON.parse(stdout) as T;
}

export interface RemoteWindowResult {
  ok: true;
  command: "controller-window";
  runId: string;
  structuredWindow: StructuredWindow;
}
