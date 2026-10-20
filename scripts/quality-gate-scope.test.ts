import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts/quality-gate-scope.sh");
const fixtures: string[] = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), "smedc-ci-scope-"));
  fixtures.push(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.email", "ci-scope@example.invalid");
  git("config", "user.name", "CI scope test");
  const write = (path: string) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), "fixture\n");
  };
  const commit = () => {
    git("add", ".");
    git("commit", "--quiet", "--allow-empty", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  write("scripts/runtime.sh");
  const base = commit();
  const run = (event = "pull_request", revision = base) =>
    spawnSync("bash", [script], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: event,
        SMEDC_PR_BASE_SHA: revision,
        SMEDC_PR_HEAD_SHA: git("rev-parse", "HEAD")
      }
    });
  return { cwd, git, write, commit, run };
}

describe("quality gate change scope", () => {
  it("skips the full gate for documentation and Skill Markdown only", () => {
    const repo = repository();
    repo.write("docs/diagram.svg");
    repo.write("skills/smedc-mcp/references/upgrade-cleanup.md");
    repo.write("README.md");
    repo.commit();
    expect(repo.run()).toMatchObject({ status: 0, stdout: "run_full=false\nrun_images=false\n" });
    for (const event of ["push", "workflow_dispatch"]) {
      expect(repo.run(event)).toMatchObject({
        status: 0,
        stdout: "run_full=true\nrun_images=true\n"
      });
    }
  });

  it.each([
    "apps/api/src/index.ts",
    ".github/workflows/phase3-quality-gates.yml",
    "scripts/official-manual-acceptance.ts",
    "packages/domain/src/business-authorization.ts",
    "unknown-runtime-input"
  ])("runs the full gate when documentation is mixed with %s", (path) => {
    const repo = repository();
    repo.write("README.md");
    repo.write(path);
    repo.commit();
    expect(repo.run()).toMatchObject({ status: 0, stdout: "run_full=true\nrun_images=true\n" });
  });

  it.each([
    "apps/api/src/auth/routes.test.ts",
    "scripts/helper.test.ts",
    "skills/smedc-mcp/scripts/helper.sh"
  ])("retains unit and integration checks without a PR image rebuild for %s", (path) => {
    const repo = repository();
    repo.write(path);
    repo.commit();
    expect(repo.run()).toMatchObject({ status: 0, stdout: "run_full=true\nrun_images=false\n" });
    expect(repo.run("push")).toMatchObject({
      status: 0,
      stdout: "run_full=true\nrun_images=true\n"
    });
  });

  it("does not hide a removed executable behind a rename to Markdown", () => {
    const repo = repository();
    repo.git("mv", "scripts/runtime.sh", "README.md");
    repo.commit();
    expect(repo.run()).toMatchObject({ status: 0, stdout: "run_full=true\nrun_images=true\n" });
  });

  it("fails closed for unavailable revisions and empty diffs", () => {
    const repo = repository();
    expect(repo.run()).toMatchObject({ status: 0, stdout: "run_full=true\nrun_images=true\n" });
    const result = repo.run("pull_request", "missing-revision");
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("run_full=false");
  });
});
