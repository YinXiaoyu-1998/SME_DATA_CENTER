import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const dockerfile = readFileSync(resolve(workspaceRoot, "Dockerfile"), "utf8");
const compose = readFileSync(resolve(workspaceRoot, "deploy/staging/docker-compose.yml"), "utf8");

function dockerStage(name: string) {
  const stage = dockerfile.match(
    new RegExp(`^FROM[^\\n]+ AS ${name}\\n([\\s\\S]*?)(?=^FROM|$)`, "m")
  );

  return stage?.[0] ?? "";
}

function composeService(name: string) {
  const start = compose.indexOf(`  ${name}:`);
  const next = compose.indexOf("\n  ", start + 1);

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

  it("provides release operations as an explicit ephemeral Compose profile", () => {
    const releaseOpsSection = composeService("release-ops");

    expect(dockerfile).toContain("FROM manifests AS release-ops-deps");
    expect(dockerfile).toContain("FROM runtime-base AS release-ops");
    expect(compose).toContain('profiles: ["release"]');
    expect(compose).toContain("${ENTERPRISE_HUB_RELEASE_OPS_IMAGE}");
    expect(releaseOpsSection).not.toContain("restart:");
    expect(releaseOpsSection).not.toContain("depends_on:");
  });
});
