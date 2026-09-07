import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    expect(imageReference("registry.example.com", "enterprise-hub", "api", "0123456789ab")).toBe(
      "registry.example.com/enterprise-hub/api:0123456789ab"
    );
  });

  it("uses an immutable sibling tag for the release operations image", () => {
    expect(
      releaseOpsImageReference("registry.example.com", "enterprise-hub", "api", "0123456789ab")
    ).toBe("registry.example.com/enterprise-hub/api:ops-0123456789ab");
  });

  it("requires the release operations sibling tag to use a 12-character SHA", () => {
    expect(() =>
      releaseOpsImageReference("registry.example.com", "enterprise-hub", "api", "0123456")
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
      stagingBuildxBuildArgs(
        "api",
        "registry.example.com/enterprise-hub/api:0123456789ab",
        "0123456789ab"
      )
    ).toEqual([
      "buildx",
      "build",
      "--pull",
      "--platform",
      "linux/amd64",
      "--target",
      "api",
      "--label",
      "org.opencontainers.image.revision=0123456789ab",
      "--provenance=false",
      "--sbom=false",
      "--tag",
      "registry.example.com/enterprise-hub/api:0123456789ab",
      "--push",
      "."
    ]);
  });
});

describe("deploy-staging remote scripts", () => {
  it("keeps every remote transaction valid Bash", () => {
    for (const script of remoteScriptsForValidation()) {
      const validation = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
      expect(validation.status, validation.stderr).toBe(0);
    }
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

  it("restores an existing two-image release when its first three-image rollout fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "enterprise-hub-rollout-"));
    const fakeBin = join(root, "bin");
    const runtimeFile = join(root, "runtime.env");
    const composeFile = join(root, "docker-compose.yml");
    const composeNext = join(root, "docker-compose.yml.next");
    const dockerState = join(root, "docker-count");
    const oldApi = "registry.example.com/enterprise-hub/api:aaaaaaaaaaaa";
    const oldWorker = "registry.example.com/enterprise-hub/worker:aaaaaaaaaaaa";
    const nextApi = "registry.example.com/enterprise-hub/api:bbbbbbbbbbbb";
    const nextWorker = "registry.example.com/enterprise-hub/worker:bbbbbbbbbbbb";
    const nextOps = "registry.example.com/enterprise-hub/api:ops-bbbbbbbbbbbb";

    try {
      await mkdir(fakeBin);
      await writeFile(
        runtimeFile,
        `ENTERPRISE_HUB_API_IMAGE=${oldApi}\nENTERPRISE_HUB_WORKER_IMAGE=${oldWorker}\n`
      );
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

      const rollout = remoteScriptsForValidation()[0]!.replaceAll("/opt/enterprise-hub", root);
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
      expect(await readFile(runtimeFile, "utf8")).toContain(`ENTERPRISE_HUB_API_IMAGE=${oldApi}\n`);
      expect(await readFile(runtimeFile, "utf8")).toContain(
        `ENTERPRISE_HUB_WORKER_IMAGE=${oldWorker}\n`
      );
      expect(await readFile(runtimeFile, "utf8")).toContain(
        `ENTERPRISE_HUB_RELEASE_OPS_IMAGE=${nextOps}\n`
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes stopped stale references while preserving images used by running containers", async () => {
    const root = await mkdtemp(join(tmpdir(), "enterprise-hub-image-cleanup-"));
    const fakeBin = join(root, "bin");
    const removedImages = join(root, "removed-images");
    const removedContainers = join(root, "removed-containers");
    const currentApi = "registry.example.com/enterprise-hub/api:bbbbbbbbbbbb";
    const currentWorker = "registry.example.com/enterprise-hub/worker:bbbbbbbbbbbb";
    const currentOps = "registry.example.com/enterprise-hub/api:ops-bbbbbbbbbbbb";
    const previousApi = "registry.example.com/enterprise-hub/api:aaaaaaaaaaaa";
    const previousWorker = "registry.example.com/enterprise-hub/worker:aaaaaaaaaaaa";
    const previousOps = "registry.example.com/enterprise-hub/api:ops-aaaaaaaaaaaa";
    const staleImages = [
      "registry.example.com/enterprise-hub/api:999999999999",
      "registry.example.com/enterprise-hub/api:ops-999999999999",
      "registry.example.com/enterprise-hub/worker:999999999999"
    ];
    const staleStoppedContainer = "stale-release-ops-container";
    const staleRunningImage = "registry.example.com/enterprise-hub/worker:888888888888";
    const staleRunningContainer = "running-stale-worker-container";

    try {
      await mkdir(fakeBin);
      await writeFile(removedImages, "");
      await writeFile(removedContainers, "");
      await writeFile(
        join(root, "previous-release.env"),
        `ENTERPRISE_HUB_API_IMAGE=${previousApi}\nENTERPRISE_HUB_WORKER_IMAGE=${previousWorker}\nENTERPRISE_HUB_RELEASE_OPS_IMAGE=${previousOps}\n`
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

      const cleanup = (remoteScriptsForValidation()[4] ?? "").replaceAll(
        "/opt/enterprise-hub",
        root
      );
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
            "registry.example.com/enterprise-hub/qdrant:v1.15.4"
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
