import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  imageReference,
  parseDeployArgs,
  remoteScriptsForValidation,
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
    const rollout = remoteScriptsForValidation()[0];
    expect(rollout).toBeDefined();
    const composeRuns = (rollout ?? "").split("\n").filter((line) => line.includes("compose run"));
    expect(composeRuns).not.toHaveLength(0);
    expect(composeRuns.every((line) => line.endsWith("</dev/null"))).toBe(true);
  });
});
