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

  it("keeps Calc, CJK fonts, Poppler and synthetic PDF verification in the worker only", () => {
    const workerSection = dockerStage("worker");
    expect(workerSection).toContain("libreoffice-calc");
    expect(workerSection).toContain("fonts-noto-cjk");
    expect(workerSection).toContain("poppler-utils");
    expect(workerSection).toContain("ledger-pdf-render-check.js");
    for (const stage of ["runtime-base", "api", "release-ops"]) {
      expect(dockerStage(stage)).not.toMatch(
        /libreoffice-calc|fonts-noto-cjk|poppler-utils|ledger-pdf-render-check/
      );
    }
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
    expect(releaseOpsDockerfile).toContain("dist/release/permissions-operator.js");
    for (const stage of ["api", "worker"])
      expect(dockerStage(stage)).not.toContain("permissions-operator.js");
    expect(releaseOpsDockerfile).toContain("dist/release/staging-upload-domain-cleanup.js");
    expect(releaseOpsDockerfile).toContain("dist/release/partition-store-cleanup.js");
    expect(releaseOpsDockerfile).toContain("dist/release/evidence-reindex.js");
    expect(releaseOpsDockerfile).toContain("dist/release/ledger-pdf.js");
    expect(releaseOpsDockerfile).toContain("dist/release/ledger-shelf-life.js");
    expect(releaseOpsDockerfile).toContain("dist/release/shelf-life-catalog.js");
    expect(releaseOpsDockerfile).toContain('CMD ["node", "dist/release/readiness.js"]');
    expect(compose).toContain('profiles: ["release"]');
    expect(compose).toContain("${SMEDC_RELEASE_OPS_IMAGE}");
    expect(releaseOpsSection).not.toContain("restart:");
    expect(releaseOpsSection).not.toContain("depends_on:");
  });

  it("vendors the release-ops Prisma engine matching the OpenSSL 3 runtime", () => {
    const dependencies = dockerStage("release-ops-deps");
    expect(dependencies).toContain("RUN PRISMA_CLI_BINARY_TARGETS=debian-openssl-3.0.x npm ci");
    expect(dependencies).toContain(
      "test -x node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x"
    );
    expect(dependencies).not.toContain("ENV PRISMA_CLI_BINARY_TARGETS");
  });

  it("checks the actual release-ops Prisma CLI in an offline read-only image", () => {
    const workflow = readFileSync(
      resolve(workspaceRoot, ".github/workflows/phase3-quality-gates.yml"),
      "utf8"
    );
    const step = workflow
      .split("- name: Verify release-ops Prisma CLI offline")[1]
      ?.split("\n      - name:")[0];
    expect(step).toBeDefined();
    expect(step).toContain("--network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m");
    expect(step).toContain("smedc-release-ops:ci node node_modules/prisma/build/index.js version");
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
