import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseEntries } from "../tsup.release.config.js";

const releaseArtifacts = ["api", "worker", "readiness", "staging-smoke"] as const;

describe("release build", () => {
  it("compiles service and release-operation entrypoints with internal packages bundled", () => {
    expect(releaseEntries).toEqual({
      api: "apps/api/src/index.ts",
      worker: "apps/worker/src/dev-loop.ts",
      readiness: "scripts/readiness.ts",
      "staging-smoke": "scripts/staging-smoke.ts"
    });

    execFileSync("npm", ["run", "build:release"], {
      cwd: process.cwd(),
      stdio: "inherit"
    });

    for (const artifact of releaseArtifacts) {
      const artifactPath = resolve(process.cwd(), "dist/release", `${artifact}.js`);

      expect(existsSync(artifactPath)).toBe(true);
      expect(readFileSync(artifactPath, "utf8")).not.toContain("@enterprise-hub/");
    }
  }, 15_000);
});
