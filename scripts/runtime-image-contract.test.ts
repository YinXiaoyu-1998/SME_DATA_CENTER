import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const dockerfile = readFileSync(resolve(workspaceRoot, "Dockerfile"), "utf8");
const compose = readFileSync(resolve(workspaceRoot, "deploy/staging/docker-compose.yml"), "utf8");

function dockerStage(name: string) {
  const stage = dockerfile.match(
    new RegExp(`^FROM[^\\n]+ AS ${name}\\n([\\s\\S]*?)(?=^FROM|(?![\\s\\S]))`, "m")
  );

  return stage?.[0] ?? "";
}

function composeService(name: string) {
  const start = compose.indexOf(`  ${name}:`);
  const remainder = compose.slice(start + 1);
  const nextService = remainder.match(/\n {2}\S[^\n]*:\n/);
  const next = nextService?.index === undefined ? -1 : start + 1 + nextService.index;

  return compose.slice(start, next === -1 ? undefined : next);
}

describe("runtime image contracts", () => {
  it("runs long-lived services from compiled release artifacts", () => {
    const apiSection = dockerStage("api");
    const workerSection = dockerStage("worker");

    expect(dockerfile).toContain('CMD ["node", "dist/release/api.js"]');
    expect(dockerfile).toContain('CMD ["node", "dist/release/worker.js"]');
    expect(apiSection).not.toContain("npm run api:dev");
    expect(workerSection).not.toContain("npm run worker:dev");
  });

  it("ships the Calamine partition reader only in the worker image", () => {
    const apiSection = dockerStage("api");
    const workerSection = dockerStage("worker");

    expect(dockerfile).toContain("AS calamine-reader-build");
    expect(workerSection).toContain("smedc-calamine-reader");
    expect(apiSection).not.toContain("smedc-calamine-reader");
  });

  it("provides release operations as an explicit ephemeral Compose profile", () => {
    const releaseOpsSection = composeService("release-ops");
    const releaseOpsDockerfile = dockerfile.slice(
      dockerfile.indexOf("FROM runtime-base AS release-ops")
    );

    expect(dockerfile).toContain("FROM manifests AS release-ops-deps");
    expect(dockerfile).toContain("FROM runtime-base AS release-ops");
    expect(releaseOpsDockerfile).toContain("dist/release/official-manual-acceptance.js");
    expect(releaseOpsDockerfile).toContain("dist/release/auth-operator.js");
    expect(releaseOpsDockerfile).toContain("dist/release/staging-upload-domain-cleanup.js");
    expect(releaseOpsDockerfile).toContain('CMD ["node", "dist/release/readiness.js"]');
    expect(compose).toContain('profiles: ["release"]');
    expect(compose).toContain("${SMEDC_RELEASE_OPS_IMAGE}");
    expect(releaseOpsSection).not.toContain("restart:");
    expect(releaseOpsSection).not.toContain("depends_on:");
  });

  it("passes the public origin to release operations", () => {
    expect(composeService("release-ops")).toContain(
      "SMEDC_PUBLIC_ORIGIN: ${SMEDC_PUBLIC_ORIGIN:-https://api.smedatacenter.xyz}"
    );
  });

  it("mounts a dedicated worker partition scratch directory", () => {
    expect(composeService("worker")).toContain(
      "/opt/smedc/partition-work:/var/lib/smedc/partition-work"
    );
  });
});
