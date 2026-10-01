import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedPaths, qualityScope } from "./ci-quality-scope.js";

const full = { code: true, node_images: true, pdf: true, integration: true };

describe("PR quality check selection", () => {
  it("keeps main pushes, manual dispatches and unknown events fully qualified", () => {
    for (const event of ["push", "workflow_dispatch", ""]) {
      expect(qualityScope(event, ["docs/guide.md"])).toEqual(full);
    }
  });

  it("makes documentation-only PRs lightweight, including an empty diff", () => {
    for (const paths of [[], ["docs/guide.md", "README.md", "skills/smedc-mcp/SKILL.md"]]) {
      expect(qualityScope("pull_request", paths)).toEqual({
        code: false,
        node_images: false,
        pdf: false,
        integration: false
      });
    }
  });

  it("runs parser checks without rebuilding unrelated Node images", () => {
    expect(
      qualityScope("pull_request", ["services/pdf-parser/src/smedc_pdf_parser/convert.py"])
    ).toEqual({
      code: true,
      node_images: false,
      pdf: true,
      integration: true
    });
  });

  it("runs Node images without OCR for unrelated UI changes", () => {
    expect(qualityScope("pull_request", ["apps/admin-web/src/app.ts", "docs/guide.md"])).toEqual({
      code: true,
      node_images: true,
      pdf: false,
      integration: true
    });
  });

  it("keeps PDF contract, storage, worker and release consumers covered", () => {
    for (const path of [
      "packages/domain/src/pdf-evidence.ts",
      "packages/db/prisma/schema.prisma",
      "packages/storage/src/local-storage.ts",
      "apps/worker/src/worker.ts",
      "apps/api/src/routes/evidence.ts",
      "apps/api/src/pdf-upload-admission.ts",
      "scripts/pdf-release.ts",
      "scripts/deploy-staging.ts",
      "scripts/readiness.ts",
      "scripts/official-manual-acceptance.ts",
      "scripts/official-manual-remote-controller.ts",
      "scripts/check-vulnerability-policy.ts",
      "deploy/pdf/release-guard.sh",
      "fixtures/evidence/pdf/contracts/valid.json"
    ])
      expect(qualityScope("pull_request", [path])).toEqual(full);
  });

  it("does not mistake Markdown evidence or unknown runtime content for documentation", () => {
    expect(qualityScope("pull_request", ["fixtures/evidence/sop.md"]).node_images).toBe(true);
    expect(qualityScope("pull_request", ["apps/api/prompts/policy.md"]).node_images).toBe(true);
    expect(qualityScope("pull_request", ["future-runtime/config.toml"])).toEqual(full);
  });

  it("qualifies all consumers after dependency, workflow or selector changes", () => {
    for (const path of [
      "package-lock.json",
      "Dockerfile",
      "tsconfig.json",
      ".dockerignore",
      ".github/actions/pdf-dependencies/action.yml",
      ".github/workflows/phase3-quality-gates.yml",
      "scripts/ci-quality-scope.ts"
    ])
      expect(qualityScope("pull_request", [path])).toEqual(full);
  });

  it("does not rebuild images just for unrelated unit tests or lint settings", () => {
    expect(qualityScope("pull_request", ["apps/admin-web/src/app.test.ts"]).node_images).toBe(
      false
    );
    expect(qualityScope("pull_request", ["eslint.config.js"])).toEqual({
      code: true,
      node_images: false,
      pdf: false,
      integration: false
    });
  });

  it("compares all PR commits and retains deletions/renames; malformed or missing refs fail", () => {
    const cwd = mkdtempSync(join(tmpdir(), "smedc-ci-scope-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }).trim();
    try {
      git("init", "-q");
      git("config", "user.name", "CI scope fixture");
      git("config", "user.email", "fixture@example.invalid");
      mkdirSync(join(cwd, "apps/api"), { recursive: true });
      mkdirSync(join(cwd, "docs"));
      writeFileSync(join(cwd, "apps/api/evidence.ts"), "original\n");
      git("add", ".");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD");
      renameSync(join(cwd, "apps/api/evidence.ts"), join(cwd, "docs/moved.md"));
      git("add", ".");
      git("commit", "-qm", "move code into docs");
      writeFileSync(join(cwd, "docs/name with\nnewline.md"), "docs\n");
      git("add", ".");
      git("commit", "-qm", "later docs edit");
      const head = git("rev-parse", "HEAD");
      const paths = changedPaths(base, head, cwd);
      expect(paths).toEqual([
        "apps/api/evidence.ts",
        "docs/moved.md",
        "docs/name with\nnewline.md"
      ]);
      expect(qualityScope("pull_request", paths)).toEqual(full);
      expect(() => changedPaths("--help", head, cwd)).toThrow("full commit SHA");
      expect(() => changedPaths("0".repeat(40), head, cwd)).toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
