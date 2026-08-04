import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_REGISTRY = "crpi-yyglilct3xi9outz.cn-beijing.personal.cr.aliyuncs.com";
const DEFAULT_NAMESPACE = "enterprise-hub";
const DEFAULT_ACR_USERNAME = "nick2373262573";
const DEFAULT_STAGING_HOST = "39.96.66.185";
const DEFAULT_PUBLIC_URL = "https://api.smedatacenter.xyz";
const DEFAULT_ACR_KEYCHAIN_SERVICE = "com.sme_data_center.acr.personal.enterprise-hub";
const DEFAULT_CURSOR_KEYCHAIN_SERVICE = "com.sme_data_center.cursor.staging";
const DEFAULT_CURSOR_KEYCHAIN_ACCOUNT = "enterprise-hub-staging";
const BASH_DOLLAR = "$";

export interface DeployOptions {
  dryRun: boolean;
  help: boolean;
  rollback: boolean;
  skipBuild: boolean;
  skipMigrate: boolean;
  skipSmoke: boolean;
  tag?: string;
}

interface DeployConfig {
  acrKeychainService: string;
  acrUsername: string;
  apiRepository: string;
  composeFile: string;
  cursorKeychainAccount: string;
  cursorKeychainService: string;
  knownHostsFile: string;
  namespace: string;
  publicUrl: string;
  registry: string;
  repoRoot: string;
  sshKeyFile: string;
  sshTarget: string;
  stagingHost: string;
  stagingUser: string;
  workerRepository: string;
}

interface RunOptions {
  capture?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  stderr?: "inherit" | "ignore";
}

const REMOTE_ROLLOUT_SCRIPT = String.raw`
set -Eeuo pipefail

runtime_file=/opt/enterprise-hub/runtime.env
compose_file=/opt/enterprise-hub/docker-compose.yml
compose_next=/opt/enterprise-hub/docker-compose.yml.next
previous_file=/opt/enterprise-hub/previous-release.env
previous_compose=/opt/enterprise-hub/previous-docker-compose.yml
api_image="$1"
worker_image="$2"
release_ops_image="$3"
run_migrate="$4"

exec 9>/opt/enterprise-hub/deploy.lock
if ! flock -n 9; then
  echo "Another staging deployment is already running." >&2
  exit 75
fi

test -f "$runtime_file"
test -f "$compose_next"
umask 077

compose() {
  docker compose --env-file "$runtime_file" -f "$compose_file" "$@"
}

update_images() {
  local next_api="$1"
  local next_worker="$2"
  local next_release_ops="$3"
  local temp_file
  temp_file="$(mktemp "${BASH_DOLLAR}{runtime_file}.XXXXXX")"
  awk '
    !/^ENTERPRISE_HUB_API_IMAGE=/ &&
    !/^ENTERPRISE_HUB_WORKER_IMAGE=/ &&
    !/^ENTERPRISE_HUB_RELEASE_OPS_IMAGE=/
  ' "$runtime_file" > "$temp_file"
  printf 'ENTERPRISE_HUB_API_IMAGE=%s\n' "$next_api" >> "$temp_file"
  printf 'ENTERPRISE_HUB_WORKER_IMAGE=%s\n' "$next_worker" >> "$temp_file"
  printf 'ENTERPRISE_HUB_RELEASE_OPS_IMAGE=%s\n' "$next_release_ops" >> "$temp_file"
  install -o root -g root -m 0600 "$temp_file" "$runtime_file"
  rm -f "$temp_file"
}

wait_for_url() {
  local url="$1"
  local label="$2"
  local attempt
  for attempt in $(seq 1 60); do
    if curl -fsS --max-time 5 -o /dev/null "$url"; then
      return 0
    fi
    sleep 2
  done
  echo "Timed out waiting for $label." >&2
  return 1
}

rollback_armed=0
rollback_on_error() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$rollback_armed" -eq 1 ] && [ -f "$previous_file" ]; then
    set +e
    previous_api="$(sed -n 's/^ENTERPRISE_HUB_API_IMAGE=//p' "$previous_file" | tail -n 1)"
    previous_worker="$(sed -n 's/^ENTERPRISE_HUB_WORKER_IMAGE=//p' "$previous_file" | tail -n 1)"
    previous_release_ops="$(sed -n 's/^ENTERPRISE_HUB_RELEASE_OPS_IMAGE=//p' "$previous_file" | tail -n 1)"
    if [ -n "$previous_api" ] && [ -n "$previous_worker" ] && [ -n "$previous_release_ops" ]; then
      echo "Rollout failed; restoring the previous API and worker images." >&2
      if [ -f "$previous_compose" ]; then
        install -o root -g root -m 0644 "$previous_compose" "$compose_file"
      fi
      update_images "$previous_api" "$previous_worker" "$previous_release_ops"
      compose pull api worker
      compose up -d api worker
      wait_for_url http://127.0.0.1:3000/healthz "rolled-back API health"
    fi
    set -e
  fi
  exit "$status"
}
trap rollback_on_error EXIT

ENTERPRISE_HUB_API_IMAGE="$api_image" \
ENTERPRISE_HUB_WORKER_IMAGE="$worker_image" \
ENTERPRISE_HUB_RELEASE_OPS_IMAGE="$release_ops_image" \
  docker compose --env-file "$runtime_file" -f "$compose_next" config --quiet

current_api="$(sed -n 's/^ENTERPRISE_HUB_API_IMAGE=//p' "$runtime_file" | tail -n 1)"
current_worker="$(sed -n 's/^ENTERPRISE_HUB_WORKER_IMAGE=//p' "$runtime_file" | tail -n 1)"
current_release_ops="$(sed -n 's/^ENTERPRISE_HUB_RELEASE_OPS_IMAGE=//p' "$runtime_file" | tail -n 1)"
test -n "$current_api"
test -n "$current_worker"
if [ -z "$current_release_ops" ]; then
  current_release_ops="$release_ops_image"
fi
test -n "$current_release_ops"
printf 'ENTERPRISE_HUB_API_IMAGE=%s\nENTERPRISE_HUB_WORKER_IMAGE=%s\nENTERPRISE_HUB_RELEASE_OPS_IMAGE=%s\n' \
  "$current_api" "$current_worker" "$current_release_ops" > "$previous_file"
chown root:root "$previous_file"
chmod 0600 "$previous_file"

install -o root -g root -m 0644 "$compose_file" "$previous_compose"
rollback_armed=1
install -o root -g root -m 0644 "$compose_next" "$compose_file"
rm -f "$compose_next"
update_images "$api_image" "$worker_image" "$release_ops_image"
compose config --quiet
compose --profile release pull api worker release-ops
compose up -d qdrant
wait_for_url http://127.0.0.1:6333/collections "Qdrant"
compose --profile release run -T --rm release-ops node dist/release/readiness.js init-qdrant </dev/null
if [ "$run_migrate" = "1" ]; then
  compose --profile release run -T --rm release-ops npm run db:migrate:deploy </dev/null
fi
compose up -d --remove-orphans
wait_for_url http://127.0.0.1:3000/healthz "API health"
wait_for_url http://127.0.0.1:3000/readyz "API readiness"
compose ps
rollback_armed=0
trap - EXIT
`;

const REMOTE_ROLLBACK_SCRIPT = String.raw`
set -Eeuo pipefail

runtime_file=/opt/enterprise-hub/runtime.env
compose_file=/opt/enterprise-hub/docker-compose.yml
previous_file=/opt/enterprise-hub/previous-release.env
previous_compose=/opt/enterprise-hub/previous-docker-compose.yml
current_file=/opt/enterprise-hub/current-release.env

exec 9>/opt/enterprise-hub/deploy.lock
if ! flock -n 9; then
  echo "Another staging deployment is already running." >&2
  exit 75
fi

test -f "$runtime_file"
test -f "$compose_file"
test -f "$previous_file"
umask 077
previous_api="$(sed -n 's/^ENTERPRISE_HUB_API_IMAGE=//p' "$previous_file" | tail -n 1)"
previous_worker="$(sed -n 's/^ENTERPRISE_HUB_WORKER_IMAGE=//p' "$previous_file" | tail -n 1)"
previous_release_ops="$(sed -n 's/^ENTERPRISE_HUB_RELEASE_OPS_IMAGE=//p' "$previous_file" | tail -n 1)"
test -n "$previous_api"
test -n "$previous_worker"
test -n "$previous_release_ops"

if [ -f "$previous_compose" ]; then
  install -o root -g root -m 0644 "$previous_compose" "$compose_file"
fi

temp_file="$(mktemp "${BASH_DOLLAR}{runtime_file}.XXXXXX")"
awk '
  !/^ENTERPRISE_HUB_API_IMAGE=/ &&
  !/^ENTERPRISE_HUB_WORKER_IMAGE=/ &&
  !/^ENTERPRISE_HUB_RELEASE_OPS_IMAGE=/
' "$runtime_file" > "$temp_file"
printf 'ENTERPRISE_HUB_API_IMAGE=%s\n' "$previous_api" >> "$temp_file"
printf 'ENTERPRISE_HUB_WORKER_IMAGE=%s\n' "$previous_worker" >> "$temp_file"
printf 'ENTERPRISE_HUB_RELEASE_OPS_IMAGE=%s\n' "$previous_release_ops" >> "$temp_file"
install -o root -g root -m 0600 "$temp_file" "$runtime_file"
rm -f "$temp_file"

compose() {
  docker compose --env-file "$runtime_file" -f "$compose_file" "$@"
}

compose config --quiet
compose pull api worker
compose up -d api worker

for attempt in $(seq 1 60); do
  if curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:3000/healthz && \
     curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:3000/readyz; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "Rollback images did not become ready." >&2
    exit 1
  fi
  sleep 2
done

rollback_tag="${BASH_DOLLAR}{previous_api##*:}"
temp_current="$(mktemp "${BASH_DOLLAR}{current_file}.XXXXXX")"
printf 'GIT_SHA=%s\nENTERPRISE_HUB_API_IMAGE=%s\nENTERPRISE_HUB_WORKER_IMAGE=%s\nENTERPRISE_HUB_RELEASE_OPS_IMAGE=%s\nDEPLOYED_AT=%s\n' \
  "$rollback_tag" "$previous_api" "$previous_worker" "$previous_release_ops" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$temp_current"
install -o root -g root -m 0644 "$temp_current" "$current_file"
rm -f "$temp_current"
compose ps
`;

const REMOTE_FINALIZE_SCRIPT = String.raw`
set -Eeuo pipefail
current_file=/opt/enterprise-hub/current-release.env
git_sha="$1"
api_image="$2"
worker_image="$3"
release_ops_image="$4"
exec 9>/opt/enterprise-hub/deploy.lock
if ! flock -n 9; then
  echo "Another staging deployment is already running." >&2
  exit 75
fi
temp_file="$(mktemp "${BASH_DOLLAR}{current_file}.XXXXXX")"
printf 'GIT_SHA=%s\nENTERPRISE_HUB_API_IMAGE=%s\nENTERPRISE_HUB_WORKER_IMAGE=%s\nENTERPRISE_HUB_RELEASE_OPS_IMAGE=%s\nDEPLOYED_AT=%s\n' \
  "$git_sha" "$api_image" "$worker_image" "$release_ops_image" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$temp_file"
install -o root -g root -m 0644 "$temp_file" "$current_file"
rm -f "$temp_file"
`;

const REMOTE_SMOKE_SCRIPT = String.raw`
set -Eeuo pipefail
docker compose --profile release --env-file /opt/enterprise-hub/runtime.env \
  -f /opt/enterprise-hub/docker-compose.yml run -T --rm release-ops \
  node dist/release/staging-smoke.js </dev/null
`;

export function parseDeployArgs(argv: string[]): DeployOptions {
  const options: DeployOptions = {
    dryRun: false,
    help: false,
    rollback: false,
    skipBuild: false,
    skipMigrate: false,
    skipSmoke: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--rollback":
        options.rollback = true;
        break;
      case "--skip-build":
        options.skipBuild = true;
        break;
      case "--skip-migrate":
        options.skipMigrate = true;
        break;
      case "--skip-smoke":
        options.skipSmoke = true;
        break;
      case "--tag": {
        const tag = argv[index + 1];
        if (!tag) {
          throw new Error("--tag requires a git SHA value.");
        }
        options.tag = validateGitShaTag(tag);
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown deploy option: ${argument}`);
    }
  }

  if (options.rollback && (options.tag || options.skipBuild || options.skipMigrate)) {
    throw new Error("--rollback cannot be combined with --tag, --skip-build, or --skip-migrate.");
  }

  return options;
}

export function validateGitShaTag(tag: string): string {
  if (!/^[0-9a-f]{7,40}$/.test(tag)) {
    throw new Error("Image tag must be a lowercase 7-40 character hexadecimal git SHA.");
  }
  return tag;
}

export function imageReference(
  registry: string,
  namespace: string,
  repository: string,
  tag: string
): string {
  return `${registry}/${namespace}/${repository}:${validateGitShaTag(tag)}`;
}

export function releaseOpsImageReference(
  registry: string,
  namespace: string,
  apiRepository: string,
  tag: string
): string {
  const validatedTag = validateGitShaTag(tag);
  if (validatedTag.length !== 12) {
    throw new Error("Release operations image tag must use a 12-character git SHA.");
  }
  return `${registry}/${namespace}/${apiRepository}:ops-${validatedTag}`;
}

export function trivyRuntimeImageScanArgs(reportPath: string, image: string): string[] {
  return [
    "image",
    "--scanners",
    "vuln",
    "--pkg-types",
    "os",
    "--ignore-unfixed",
    "--severity",
    "MEDIUM,HIGH,CRITICAL",
    "--format",
    "json",
    "--output",
    reportPath,
    "--platform",
    "linux/amd64",
    image
  ];
}

export function remoteScriptsForValidation(): string[] {
  return [
    REMOTE_ROLLOUT_SCRIPT,
    REMOTE_ROLLBACK_SCRIPT,
    REMOTE_FINALIZE_SCRIPT,
    REMOTE_SMOKE_SCRIPT
  ];
}

function loadDeployConfig(env: NodeJS.ProcessEnv = process.env): DeployConfig {
  const stagingHost = env["ENTERPRISE_HUB_STAGING_HOST"] ?? DEFAULT_STAGING_HOST;
  const stagingUser = env["ENTERPRISE_HUB_STAGING_SSH_USER"] ?? "root";
  const config: DeployConfig = {
    acrKeychainService: env["ENTERPRISE_HUB_ACR_KEYCHAIN_SERVICE"] ?? DEFAULT_ACR_KEYCHAIN_SERVICE,
    acrUsername: env["ENTERPRISE_HUB_ACR_USERNAME"] ?? DEFAULT_ACR_USERNAME,
    apiRepository: env["ENTERPRISE_HUB_ACR_API_REPOSITORY"] ?? "api",
    composeFile: join(REPO_ROOT, "deploy/staging/docker-compose.yml"),
    cursorKeychainAccount:
      env["ENTERPRISE_HUB_STAGING_CURSOR_KEYCHAIN_ACCOUNT"] ?? DEFAULT_CURSOR_KEYCHAIN_ACCOUNT,
    cursorKeychainService:
      env["ENTERPRISE_HUB_STAGING_CURSOR_KEYCHAIN_SERVICE"] ?? DEFAULT_CURSOR_KEYCHAIN_SERVICE,
    knownHostsFile: join(REPO_ROOT, "deploy/staging/known_hosts"),
    namespace: env["ENTERPRISE_HUB_ACR_NAMESPACE"] ?? DEFAULT_NAMESPACE,
    publicUrl: env["ENTERPRISE_HUB_STAGING_PUBLIC_URL"] ?? DEFAULT_PUBLIC_URL,
    registry: env["ENTERPRISE_HUB_ACR_REGISTRY"] ?? DEFAULT_REGISTRY,
    repoRoot: REPO_ROOT,
    sshKeyFile: env["ENTERPRISE_HUB_STAGING_SSH_KEY"] ?? join(homedir(), ".ssh/id_ed25519"),
    sshTarget: `${stagingUser}@${stagingHost}`,
    stagingHost,
    stagingUser,
    workerRepository: env["ENTERPRISE_HUB_ACR_WORKER_REPOSITORY"] ?? "worker"
  };

  assertSafeValue("ACR registry", config.registry, /^[a-z0-9.-]+$/);
  assertSafeValue("ACR namespace", config.namespace, /^[a-z0-9._-]+$/);
  assertSafeValue("ACR username", config.acrUsername, /^[A-Za-z0-9._@-]+$/);
  assertSafeValue("API repository", config.apiRepository, /^[a-z0-9._-]+$/);
  assertSafeValue("worker repository", config.workerRepository, /^[a-z0-9._-]+$/);
  assertSafeValue("staging host", config.stagingHost, /^[A-Za-z0-9.:-]+$/);
  assertSafeValue("staging SSH user", config.stagingUser, /^[A-Za-z0-9._-]+$/);
  if (!config.publicUrl.startsWith("https://")) {
    throw new Error("ENTERPRISE_HUB_STAGING_PUBLIC_URL must use HTTPS.");
  }

  return config;
}

function assertSafeValue(label: string, value: string, pattern: RegExp): void {
  if (!pattern.test(value)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
}

async function run(
  command: string,
  args: string[],
  { capture = false, cwd = REPO_ROOT, env, input, stderr = "inherit" }: RunOptions = {}
): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: [input === undefined ? "inherit" : "pipe", capture ? "pipe" : "inherit", stderr]
    });
    let output = "";
    if (capture && child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
      });
    }
    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise(output.trim());
        return;
      }
      reject(
        new Error(
          `${command} failed${code === null ? ` with signal ${signal ?? "unknown"}` : ` with exit code ${code}`}.`
        )
      );
    });
  });
}

function sshOptions(config: DeployConfig): string[] {
  return [
    "-i",
    config.sshKeyFile,
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${config.knownHostsFile}`,
    "-o",
    "ConnectTimeout=15"
  ];
}

async function runRemoteScript(
  config: DeployConfig,
  label: string,
  script: string,
  args: string[] = []
): Promise<void> {
  console.log(`\n==> ${label}`);
  await run("ssh", [...sshOptions(config), config.sshTarget, "bash", "-s", "--", ...args], {
    input: script
  });
}

async function readSecretFromKeychain(account: string, service: string): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error(
      `Secret ${service} is not in the environment and macOS Keychain is unavailable on this platform.`
    );
  }
  const secret = await run(
    "security",
    ["find-generic-password", "-a", account, "-s", service, "-w"],
    { capture: true, stderr: "ignore" }
  );
  if (!secret) {
    throw new Error(`Keychain item ${service} returned an empty secret.`);
  }
  return secret;
}

async function acrPassword(config: DeployConfig): Promise<string> {
  const injected = process.env["ENTERPRISE_HUB_ACR_PASSWORD"];
  return injected ?? readSecretFromKeychain(config.acrUsername, config.acrKeychainService);
}

async function cursorSigningSecret(config: DeployConfig): Promise<string> {
  const injected = process.env["ENTERPRISE_HUB_STAGING_CURSOR_SIGNING_SECRET"];
  return (
    injected ?? readSecretFromKeychain(config.cursorKeychainAccount, config.cursorKeychainService)
  );
}

async function installRemoteCursorSigningSecret(config: DeployConfig): Promise<void> {
  const secret = await cursorSigningSecret(config);
  const command = [
    "set -Eeuo pipefail",
    "runtime_file=/opt/enterprise-hub/runtime.env",
    'test -f "$runtime_file"',
    "umask 077",
    'temp_file="$(mktemp "${runtime_file}.XXXXXX")"',
    `awk '!/^CURSOR_SIGNING_SECRET=/' "$runtime_file" > "$temp_file"`,
    "IFS= read -r cursor_secret",
    'test -n "$cursor_secret"',
    `printf 'CURSOR_SIGNING_SECRET=%s\\n' "$cursor_secret" >> "$temp_file"`,
    'install -o root -g root -m 0600 "$temp_file" "$runtime_file"',
    'rm -f "$temp_file"'
  ].join("; ");
  await run("ssh", [...sshOptions(config), config.sshTarget, command], {
    input: `${secret}\n`
  });
}

async function preflight(config: DeployConfig, options: DeployOptions): Promise<string> {
  await access(config.composeFile);
  await access(config.knownHostsFile);
  await access(config.sshKeyFile);

  const root = await run("git", ["rev-parse", "--show-toplevel"], { capture: true });
  if (resolve(root) !== config.repoRoot) {
    throw new Error(`Run deploy:staging from ${config.repoRoot}.`);
  }

  const currentTag = validateGitShaTag(
    await run("git", ["rev-parse", "--short=12", "HEAD"], { capture: true })
  );
  if (!options.rollback) {
    const status = await run("git", ["status", "--porcelain"], { capture: true });
    if (status) {
      throw new Error(
        "Refusing to deploy a dirty working tree because the immutable image tag would not describe its contents."
      );
    }
    if (options.tag && !options.skipBuild && options.tag !== currentTag) {
      throw new Error(
        "A custom --tag requires --skip-build unless it equals the current commit SHA."
      );
    }
  }

  return options.tag ?? currentTag;
}

async function verifySsh(config: DeployConfig): Promise<void> {
  console.log("\n==> Verify strict SSH host identity and access");
  await run("ssh", [...sshOptions(config), config.sshTarget, "true"]);
}

async function loginToAcr(config: DeployConfig, password: string, local: boolean): Promise<void> {
  console.log(`\n==> Authenticate ${local ? "local Docker" : "staging Docker"} to ACR`);
  if (local) {
    await run(
      "docker",
      ["login", "--username", config.acrUsername, "--password-stdin", config.registry],
      { input: `${password}\n` }
    );
    return;
  }

  const remoteCommand = `docker login --username '${config.acrUsername}' --password-stdin '${config.registry}'`;
  await run("ssh", [...sshOptions(config), config.sshTarget, remoteCommand], {
    input: `${password}\n`
  });
}

async function buildAndPush(
  config: DeployConfig,
  apiImage: string,
  workerImage: string,
  releaseOpsImage: string,
  tag: string
): Promise<void> {
  console.log("\n==> Build and push linux/amd64 API image");
  await run("docker", [
    "buildx",
    "build",
    "--pull",
    "--platform",
    "linux/amd64",
    "--target",
    "api",
    "--label",
    `org.opencontainers.image.revision=${tag}`,
    "--tag",
    apiImage,
    "--push",
    "."
  ]);

  console.log("\n==> Build and push linux/amd64 worker image");
  await run("docker", [
    "buildx",
    "build",
    "--pull",
    "--platform",
    "linux/amd64",
    "--target",
    "worker",
    "--label",
    `org.opencontainers.image.revision=${tag}`,
    "--tag",
    workerImage,
    "--push",
    "."
  ]);

  console.log("\n==> Build and push linux/amd64 release-ops image");
  await run("docker", [
    "buildx",
    "build",
    "--pull",
    "--platform",
    "linux/amd64",
    "--target",
    "release-ops",
    "--label",
    `org.opencontainers.image.revision=${tag}`,
    "--tag",
    releaseOpsImage,
    "--push",
    "."
  ]);
}

async function scanImages(
  apiImage: string,
  workerImage: string,
  releaseOpsImage: string
): Promise<void> {
  const reportDirectory = await mkdtemp(join(tmpdir(), "enterprise-hub-trivy-"));
  try {
    for (const [service, component, image] of [
      ["API", "api-image", apiImage],
      ["worker", "worker-image", workerImage],
      ["release-ops", "release-ops-image", releaseOpsImage]
    ] as const) {
      const report = join(reportDirectory, `${component}.json`);
      console.log(`\n==> Scan ${service} image through the dependency risk policy`);
      await run("trivy", trivyRuntimeImageScanArgs(report, image));
      await run("npm", [
        "run",
        "audit:report",
        "--",
        "--kind",
        "trivy",
        "--component",
        component,
        "--input",
        report
      ]);
      console.log(`${service} image passed the dependency risk policy.`);
    }
  } finally {
    await rm(reportDirectory, { recursive: true, force: true });
  }
}

async function uploadCompose(config: DeployConfig): Promise<void> {
  await runRemoteScript(
    config,
    "Prepare staging runtime directory",
    "set -Eeuo pipefail\ninstall -d -o root -g root -m 0755 /opt/enterprise-hub\n"
  );
  console.log("\n==> Upload versioned staging Compose definition");
  await run("scp", [
    ...sshOptions(config),
    config.composeFile,
    `${config.sshTarget}:/opt/enterprise-hub/docker-compose.yml.next`
  ]);
}

async function publicChecks(config: DeployConfig): Promise<void> {
  console.log("\n==> Verify public HTTPS liveness and private readiness boundary");
  await waitForPublicStatus(`${config.publicUrl}/healthz`, 200);
  await waitForPublicStatus(`${config.publicUrl}/readyz`, 404);
}

async function waitForPublicStatus(url: string, expectedStatus: number): Promise<void> {
  let lastStatus = "unreachable";
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      lastStatus = await run(
        "curl",
        [
          "--noproxy",
          "*",
          "--silent",
          "--show-error",
          "--output",
          "/dev/null",
          "--write-out",
          "%{http_code}",
          "--max-time",
          "10",
          url
        ],
        { capture: true }
      );
      if (Number(lastStatus) === expectedStatus) {
        return;
      }
    } catch {
      lastStatus = "unreachable";
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`Expected HTTP ${expectedStatus} from ${url}; last result was ${lastStatus}.`);
}

async function runSmoke(config: DeployConfig): Promise<void> {
  console.log("\n==> Run fixture-only staging smoke");
  await runRemoteScript(config, "Run fixture-only staging smoke", REMOTE_SMOKE_SCRIPT);
}

async function rollback(config: DeployConfig): Promise<void> {
  await runRemoteScript(
    config,
    "Restore previous API and worker image release",
    REMOTE_ROLLBACK_SCRIPT
  );
}

function printPlan(
  options: DeployOptions,
  config: DeployConfig,
  tag: string,
  apiImage: string,
  workerImage: string,
  releaseOpsImage: string
): void {
  console.log(
    JSON.stringify(
      {
        mode: options.rollback ? "rollback" : "deploy",
        target: config.sshTarget,
        tag,
        apiImage,
        workerImage,
        releaseOpsImage,
        build: !options.skipBuild && !options.rollback,
        migrate: !options.skipMigrate && !options.rollback,
        smoke: !options.skipSmoke,
        vulnerabilityScan: !options.rollback,
        autoRollbackOnFailure: true
      },
      null,
      2
    )
  );
}

function helpText(): string {
  return `Usage: npm run deploy:staging -- [options]

Builds immutable linux/amd64 API, worker, and release-ops images, pushes them to
the approved Beijing ACR registry, rolls them out on staging, applies Prisma
migrations, checks local readiness/public liveness, and runs the fixture-only
smoke test.

Options:
  --dry-run        Print the release plan without Docker, SSH, or cloud changes
  --tag <git-sha>  Deploy an existing immutable tag (requires --skip-build unless current)
  --skip-build     Reuse images already present in ACR
  --skip-migrate   Do not run prisma migrate deploy
  --skip-smoke     Do not run the fixture-only upload/index/search smoke
  --rollback       Restore /opt/enterprise-hub/previous-release.env
  -h, --help       Show this help

Secrets default to macOS Keychain. Non-interactive runners may inject
ENTERPRISE_HUB_ACR_PASSWORD and ENTERPRISE_HUB_STAGING_CURSOR_SIGNING_SECRET from an
approved secret manager. The script never prints either value.`;
}

async function main(): Promise<void> {
  const options = parseDeployArgs(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return;
  }

  const config = loadDeployConfig();
  const tag = await preflight(config, options);
  const apiImage = imageReference(config.registry, config.namespace, config.apiRepository, tag);
  const workerImage = imageReference(
    config.registry,
    config.namespace,
    config.workerRepository,
    tag
  );
  const releaseOpsImage = releaseOpsImageReference(
    config.registry,
    config.namespace,
    config.apiRepository,
    tag
  );
  printPlan(options, config, tag, apiImage, workerImage, releaseOpsImage);
  if (options.dryRun) {
    return;
  }

  await verifySsh(config);
  const password = await acrPassword(config);
  if (options.rollback) {
    await loginToAcr(config, password, false);
    await rollback(config);
    await publicChecks(config);
    if (!options.skipSmoke) {
      await runSmoke(config);
    }
    console.log("\nStaging rollback completed and verified.");
    return;
  }

  if (!options.skipBuild) {
    console.log("\n==> Verify local Docker Buildx");
    await run("docker", ["info"]);
    await run("docker", ["buildx", "version"]);
  }

  await loginToAcr(config, password, true);
  if (!options.skipBuild) {
    await buildAndPush(config, apiImage, workerImage, releaseOpsImage, tag);
  }
  await scanImages(apiImage, workerImage, releaseOpsImage);

  await loginToAcr(config, password, false);
  await uploadCompose(config);
  await installRemoteCursorSigningSecret(config);
  let releaseNeedsRollback = false;
  try {
    await runRemoteScript(config, "Roll out staging release", REMOTE_ROLLOUT_SCRIPT, [
      apiImage,
      workerImage,
      releaseOpsImage,
      options.skipMigrate ? "0" : "1"
    ]);
    releaseNeedsRollback = true;
    await publicChecks(config);
    if (!options.skipSmoke) {
      await runSmoke(config);
    }
    await runRemoteScript(config, "Record verified staging release", REMOTE_FINALIZE_SCRIPT, [
      tag,
      apiImage,
      workerImage,
      releaseOpsImage
    ]);
    releaseNeedsRollback = false;
  } catch (error) {
    if (releaseNeedsRollback) {
      console.error("\nPost-rollout verification failed; restoring the previous image release.");
      try {
        await rollback(config);
      } catch (rollbackError) {
        console.error(
          `Automatic rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        );
      }
    }
    throw error;
  }

  console.log(`\nStaging release ${tag} completed and verified.`);
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
