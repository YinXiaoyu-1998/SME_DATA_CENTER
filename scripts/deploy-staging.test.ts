import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  imageReference,
  parseDeployArgs,
  releaseOpsImageReference,
  remoteScriptsForValidation,
  stagingBuildxBuildArgs,
  trivyRuntimeImageScanArgs,
  validateGitShaTag
} from "./deploy-staging.js";

describe("deploy-staging argument parsing", () => {
  it("uses the safe full deployment defaults", () => {
    expect(parseDeployArgs([])).toEqual({
      dryRun: false,
      help: false,
      rollback: false,
      skipBuild: false,
      skipMigrate: false,
      skipSmoke: false
    });
  });

  it("supports redeploying an existing immutable tag", () => {
    expect(
      parseDeployArgs([
        "--tag",
        "0123456789ab",
        "--skip-build",
        "--skip-migrate",
        "--skip-smoke",
        "--dry-run"
      ])
    ).toEqual({
      dryRun: true,
      help: false,
      rollback: false,
      skipBuild: true,
      skipMigrate: true,
      skipSmoke: true,
      tag: "0123456789ab"
    });
  });

  it("rejects mutable or non-SHA image tags", () => {
    expect(() => validateGitShaTag("latest")).toThrow(/git SHA/);
    expect(() => parseDeployArgs(["--tag", "ABCDEF123456"])).toThrow(/git SHA/);
  });

  it("keeps rollback mode unambiguous", () => {
    expect(parseDeployArgs(["--rollback", "--skip-smoke"])).toMatchObject({
      rollback: true,
      skipSmoke: true
    });
    expect(() => parseDeployArgs(["--rollback", "--tag", "0123456"])).toThrow(/cannot be combined/);
  });

  it("rejects unknown options", () => {
    expect(() => parseDeployArgs(["--force"])).toThrow(/Unknown deploy option/);
  });
});

describe("deploy-staging image references", () => {
  it("uses the approved registry namespace and immutable tag", () => {
    expect(imageReference("registry.example.com", "smedc", "api", "0123456789ab")).toBe(
      "registry.example.com/smedc/api:0123456789ab"
    );
  });

  it("uses an immutable sibling tag for the release operations image", () => {
    expect(releaseOpsImageReference("registry.example.com", "smedc", "api", "0123456789ab")).toBe(
      "registry.example.com/smedc/api:ops-0123456789ab"
    );
  });

  it("requires the release operations sibling tag to use a 12-character SHA", () => {
    expect(() =>
      releaseOpsImageReference("registry.example.com", "smedc", "api", "0123456")
    ).toThrow(/12-character/);
  });
});

describe("deploy-staging runtime image scans", () => {
  it("matches the quality gate runtime vulnerability policy scope", () => {
    expect(
      trivyRuntimeImageScanArgs("/tmp/api.json", "registry.example.com/api:0123456789ab")
    ).toEqual([
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
      "/tmp/api.json",
      "--platform",
      "linux/amd64",
      "registry.example.com/api:0123456789ab"
    ]);
  });
});

describe("deploy-staging image build", () => {
  it("disables BuildKit attestations for the ACR Personal Edition registry", () => {
    expect(
      stagingBuildxBuildArgs("api", "registry.example.com/smedc/api:0123456789ab", "0123456789ab")
    ).toEqual([
      "buildx",
      "build",
      "--pull",
      "--no-cache-filter",
      "runtime-base",
      "--platform",
      "linux/amd64",
      "--target",
      "api",
      "--label",
      "org.opencontainers.image.revision=0123456789ab",
      "--provenance=false",
      "--sbom=false",
      "--tag",
      "registry.example.com/smedc/api:0123456789ab",
      "--push",
      "."
    ]);
  });

  it("refreshes worker OS dependencies even when the base image has no new packages", () => {
    const args = stagingBuildxBuildArgs(
      "worker",
      "registry.example.com/smedc/worker:0123456789ab",
      "0123456789ab"
    );
    expect(args[args.indexOf("--no-cache-filter") + 1]).toBe("runtime-base,worker");
    expect(args).not.toContain("--no-cache");
  });
});

describe("deploy-staging remote scripts", () => {
  it("keeps every remote transaction valid Bash", () => {
    for (const script of remoteScriptsForValidation()) {
      const validation = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
      expect(validation.status, validation.stderr).toBe(0);
    }
  });

  it("packages the public site with the release and restores its previous version on rollback", () => {
    const [rollout, rollback] = remoteScriptsForValidation();
    expect(rollout).toContain('marketing_publish "$release_ops_image"');
    expect(rollout).toContain("marketing_restore");
    expect(rollback).toContain("marketing_restore");
    expect(rollout).toContain("/app/dist/marketing/.");
    expect(rollout).toContain("/opt/smedc/marketing-enabled");
  });

  it("parses rollback metadata as data instead of sourcing it as shell", () => {
    for (const script of remoteScriptsForValidation()) {
      expect(script).not.toContain('. "$previous_file"');
    }
  });

  it("keeps remote compose jobs from consuming the remaining SSH script", () => {
    const scripts = remoteScriptsForValidation();
    const rollout = scripts[0];
    expect(rollout).toBeDefined();
    const composeRuns = scripts
      .flatMap((script) => script.split("\n"))
      .filter((line) => line.includes("compose ") && line.includes(" run "));
    expect(composeRuns).not.toHaveLength(0);
    expect(composeRuns.every((line) => line.endsWith("</dev/null"))).toBe(true);
  });

  it("runs release operations in the ephemeral release-ops service", () => {
    const [rollout, , , smokeCommand] = remoteScriptsForValidation();

    expect(rollout).toContain("compose --profile release run -T --rm release-ops");
    expect(rollout).not.toContain("compose run -T --rm api npm run db:migrate:deploy");
    expect(rollout).not.toContain("release-ops npm run db:migrate:deploy");
    expect(rollout).toContain(
      "release-ops node node_modules/prisma/build/index.js migrate deploy --config packages/db/prisma.config.ts"
    );
    expect(smokeCommand).toContain("node dist/release/staging-smoke.js");
  });

  it("prepares the worker partition scratch directory before Docker is invoked", async () => {
    const root = await mkdtemp(join(tmpdir(), "smedc-partition-workdir-"));
    const fakeBin = join(root, "bin");
    const runtimeFile = join(root, "runtime.env");
    const composeNext = join(root, "docker-compose.yml.next");
    const installLog = join(root, "install.log");

    try {
      await mkdir(fakeBin);
      await writeFile(runtimeFile, "SMEDC_API_IMAGE=old-api\nSMEDC_WORKER_IMAGE=old-worker\n");
      await writeFile(composeNext, "services: {}\n");
      await writeFile(
        join(fakeBin, "install"),
        `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "-d" ]; then
  printf '%s\\n' "$*" >> "$FAKE_INSTALL_LOG"
  mkdir -p "\${@: -1}"
  exit 0
fi
files=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|-g|-m) shift 2 ;;
    *) files+=("$1"); shift ;;
  esac
done
cp "\${files[0]}" "\${files[1]}"
`
      );
      await writeFile(join(fakeBin, "flock"), "#!/usr/bin/env bash\nexit 0\n");
      await writeFile(join(fakeBin, "docker"), "#!/usr/bin/env bash\nexit 42\n");
      await Promise.all(
        ["docker", "flock", "install"].map((command) => chmod(join(fakeBin, command), 0o755))
      );

      const rollout = remoteScriptsForValidation()[0]!.replaceAll("/opt/smedc", root);
      const result = spawnSync(
        "bash",
        ["-s", "--", "registry/api:next", "registry/worker:next", "registry/api:ops-next", "0"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            FAKE_INSTALL_LOG: installLog,
            PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`
          },
          input: rollout
        }
      );

      expect(result.status).toBe(42);
      expect(await readFile(installLog, "utf8")).toBe(
        `-d -o 1000 -g 1000 -m 0750 ${join(root, "partition-work")}\n`
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores an existing two-image release when its first three-image rollout fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "smedc-rollout-"));
    const fakeBin = join(root, "bin");
    const runtimeFile = join(root, "runtime.env");
    const composeFile = join(root, "docker-compose.yml");
    const composeNext = join(root, "docker-compose.yml.next");
    const dockerState = join(root, "docker-count");
    const oldApi = "registry.example.com/smedc/api:aaaaaaaaaaaa";
    const oldWorker = "registry.example.com/smedc/worker:aaaaaaaaaaaa";
    const nextApi = "registry.example.com/smedc/api:bbbbbbbbbbbb";
    const nextWorker = "registry.example.com/smedc/worker:bbbbbbbbbbbb";
    const nextOps = "registry.example.com/smedc/api:ops-bbbbbbbbbbbb";

    try {
      await mkdir(fakeBin);
      await writeFile(runtimeFile, `SMEDC_API_IMAGE=${oldApi}\nSMEDC_WORKER_IMAGE=${oldWorker}\n`);
      await writeFile(composeFile, "legacy-compose\n");
      await writeFile(composeNext, "three-image-compose\n");
      await writeFile(
        join(fakeBin, "docker"),
        `#!/usr/bin/env bash
set -euo pipefail
count=0
if [ -f "$FAKE_DOCKER_STATE" ]; then count="$(<"$FAKE_DOCKER_STATE")"; fi
count=$((count + 1))
printf '%s\n' "$count" > "$FAKE_DOCKER_STATE"
if [ "$count" -eq 2 ]; then exit 42; fi
`
      );
      await writeFile(
        join(fakeBin, "install"),
        `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "-d" ]; then
  mkdir -p "\${@: -1}"
  exit 0
fi
files=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|-g|-m) shift 2 ;;
    *) files+=("$1"); shift ;;
  esac
done
cp "\${files[0]}" "\${files[1]}"
`
      );
      for (const command of ["chown", "flock"]) {
        await writeFile(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
      }
      await writeFile(join(fakeBin, "curl"), "#!/usr/bin/env bash\nexit 0\n");
      await Promise.all(
        ["docker", "install", "chown", "flock", "curl"].map((command) =>
          chmod(join(fakeBin, command), 0o755)
        )
      );

      const rollout = remoteScriptsForValidation()[0]!.replaceAll("/opt/smedc", root);
      const result = spawnSync("bash", ["-s", "--", nextApi, nextWorker, nextOps, "0"], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_DOCKER_STATE: dockerState,
          PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`
        },
        input: rollout
      });

      expect(result.status, result.stderr).toBe(42);
      expect(await readFile(composeFile, "utf8")).toBe("legacy-compose\n");
      expect(await readFile(runtimeFile, "utf8")).toContain(`SMEDC_API_IMAGE=${oldApi}\n`);
      expect(await readFile(runtimeFile, "utf8")).toContain(`SMEDC_WORKER_IMAGE=${oldWorker}\n`);
      expect(await readFile(runtimeFile, "utf8")).toContain(`SMEDC_RELEASE_OPS_IMAGE=${nextOps}\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("switches the served site and restores it with the existing release rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "smedc-site-rollout-"));
    const bin = join(root, "bin");
    try {
      await mkdir(bin);
      await mkdir(join(root, "marketing/releases/old"), { recursive: true });
      await writeFile(join(root, "marketing/releases/old/index.html"), "previous public page");
      await symlink("releases/old", join(root, "marketing/current"));
      await writeFile(
        join(root, "runtime.env"),
        "SMEDC_API_IMAGE=registry/api:aaaaaaaaaaaa\nSMEDC_WORKER_IMAGE=registry/worker:aaaaaaaaaaaa\nSMEDC_RELEASE_OPS_IMAGE=registry/api:ops-aaaaaaaaaaaa\n"
      );
      await writeFile(join(root, "docker-compose.yml"), "old compose");
      await writeFile(join(root, "docker-compose.yml.next"), "new compose");
      const commands: Record<string, string> = {
        docker: `case "$1" in
  create) echo site-container ;;
  cp) mkdir -p "$3/assets"; printf 'new public page' > "$3/index.html"; printf '{}' > "$3/version.json"; printf 'image' > "$3/assets/hero.webp" ;;
esac`,
        install: `if [ "$1" = "-d" ]; then mkdir -p "\${@: -1}"; exit 0; fi
files=()
while [ "$#" -gt 0 ]; do
  case "$1" in -o|-g|-m) shift 2 ;; *) files+=("$1"); shift ;; esac
done
cp "\${files[0]}" "\${files[1]}"`,
        // Host uses GNU mv -T; emulate that OS boundary on macOS test machines.
        mv: `"${process.execPath}" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$2" "$3"`,
        chown: "exit 0",
        flock: "exit 0",
        curl: "exit 0"
      };
      for (const [command, body] of Object.entries(commands)) {
        await writeFile(join(bin, command), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
        await chmod(join(bin, command), 0o755);
      }
      const [rollout, rollback] = remoteScriptsForValidation();
      const run = (script: string, args: string[]) =>
        spawnSync("bash", ["-s", "--", ...args], {
          input: script.replaceAll("/opt/smedc", root),
          encoding: "utf8",
          timeout: 4_000,
          env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` }
        });
      const deployed = run(rollout!, [
        "registry/api:bbbbbbbbbbbb",
        "registry/worker:bbbbbbbbbbbb",
        "registry/api:ops-bbbbbbbbbbbb",
        "0"
      ]);
      expect(deployed.status, deployed.stderr).toBe(0);
      expect(await readFile(join(root, "marketing/current/index.html"), "utf8")).toBe(
        "new public page"
      );
      const restored = run(rollback!, []);
      expect(restored.status, restored.stderr).toBe(0);
      expect(await readFile(join(root, "marketing/current/index.html"), "utf8")).toBe(
        "previous public page"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("removes stopped stale references while preserving images used by running containers", async () => {
    const root = await mkdtemp(join(tmpdir(), "smedc-image-cleanup-"));
    const fakeBin = join(root, "bin");
    const removedImages = join(root, "removed-images");
    const removedContainers = join(root, "removed-containers");
    const currentApi = "registry.example.com/smedc/api:bbbbbbbbbbbb";
    const currentWorker = "registry.example.com/smedc/worker:bbbbbbbbbbbb";
    const currentOps = "registry.example.com/smedc/api:ops-bbbbbbbbbbbb";
    const previousApi = "registry.example.com/smedc/api:aaaaaaaaaaaa";
    const previousWorker = "registry.example.com/smedc/worker:aaaaaaaaaaaa";
    const previousOps = "registry.example.com/smedc/api:ops-aaaaaaaaaaaa";
    const staleImages = [
      "registry.example.com/smedc/api:999999999999",
      "registry.example.com/smedc/api:ops-999999999999",
      "registry.example.com/smedc/worker:999999999999"
    ];
    const staleStoppedContainer = "stale-release-ops-container";
    const staleRunningImage = "registry.example.com/smedc/worker:888888888888";
    const staleRunningContainer = "running-stale-worker-container";

    try {
      await mkdir(fakeBin);
      await writeFile(removedImages, "");
      await writeFile(removedContainers, "");
      await writeFile(
        join(root, "previous-release.env"),
        `SMEDC_API_IMAGE=${previousApi}\nSMEDC_WORKER_IMAGE=${previousWorker}\nSMEDC_RELEASE_OPS_IMAGE=${previousOps}\n`
      );
      await writeFile(
        join(fakeBin, "docker"),
        `#!/usr/bin/env bash
set -euo pipefail
case "$1:$2" in
  image:ls) printf '%s\n' "$FAKE_DOCKER_IMAGES" ;;
  image:rm)
    if [ "$3" = "$FAKE_STOPPED_CONTAINER_IMAGE" ] && ! grep -qx "$FAKE_STOPPED_CONTAINER" "$FAKE_REMOVED_CONTAINERS"; then
      exit 1
    fi
    if [ "$3" = "$FAKE_RUNNING_CONTAINER_IMAGE" ]; then
      exit 1
    fi
    printf '%s\n' "$3" >> "$FAKE_REMOVED_IMAGES"
    ;;
  image:prune) ;;
  ps:-aq)
    if [ "$4" = "ancestor=$FAKE_STOPPED_CONTAINER_IMAGE" ]; then
      printf '%s\n' "$FAKE_STOPPED_CONTAINER"
    elif [ "$4" = "ancestor=$FAKE_RUNNING_CONTAINER_IMAGE" ]; then
      printf '%s\n' "$FAKE_RUNNING_CONTAINER"
    fi
    ;;
  inspect:--format)
    if [ "$4" = "$FAKE_RUNNING_CONTAINER" ]; then
      printf 'true\n'
    else
      printf 'false\n'
    fi
    ;;
  container:rm) printf '%s\n' "$3" >> "$FAKE_REMOVED_CONTAINERS" ;;
  *) exit 64 ;;
esac
`
      );
      await writeFile(join(fakeBin, "flock"), "#!/usr/bin/env bash\nexit 0\n");
      await Promise.all(["docker", "flock"].map((command) => chmod(join(fakeBin, command), 0o755)));

      const cleanup = (remoteScriptsForValidation()[4] ?? "").replaceAll("/opt/smedc", root);
      const result = spawnSync("bash", ["-s", "--", currentApi, currentWorker, currentOps], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_DOCKER_IMAGES: [
            currentApi,
            currentWorker,
            currentOps,
            previousApi,
            previousWorker,
            previousOps,
            ...staleImages,
            staleRunningImage,
            "registry.example.com/smedc/qdrant:v1.15.4"
          ].join("\n"),
          FAKE_REMOVED_IMAGES: removedImages,
          FAKE_REMOVED_CONTAINERS: removedContainers,
          FAKE_STOPPED_CONTAINER: staleStoppedContainer,
          FAKE_STOPPED_CONTAINER_IMAGE: staleImages[1],
          FAKE_RUNNING_CONTAINER: staleRunningContainer,
          FAKE_RUNNING_CONTAINER_IMAGE: staleRunningImage,
          PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`
        },
        input: cleanup
      });

      expect(result.status, result.stderr).toBe(0);
      expect((await readFile(removedImages, "utf8")).trim().split("\n")).toEqual(staleImages);
      expect((await readFile(removedContainers, "utf8")).trim()).toBe(staleStoppedContainer);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
