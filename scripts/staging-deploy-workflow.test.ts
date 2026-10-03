import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const qualityWorkflowPath = join(repoRoot, ".github/workflows/phase3-quality-gates.yml");
const deployWorkflowPath = join(repoRoot, ".github/workflows/staging-deploy.yml");

async function workflow(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

describe("staging GitHub Actions release boundary", () => {
  it("runs the existing quality gates for trusted main pushes", async () => {
    const source = await workflow(qualityWorkflowPath);

    expect(source).toMatch(/push:\n\s+branches:\n\s+- main/);
    expect(source).toContain('paths-ignore:\n      - "docs/**"\n      - "**/*.md"');
    expect(source).toContain("pull_request:");
  });

  it("gates unit checks and their dependent runtime jobs on the PR scope result", async () => {
    const source = await workflow(qualityWorkflowPath);
    expect(source).toContain('run: bash scripts/quality-gate-scope.sh >> "$GITHUB_OUTPUT"');
    expect(source).toContain("fetch-depth: 0");
    const unit = source.split("\n  unit-and-static:")[1]?.split("\n  runtime-images:")[0];
    expect(unit).toContain("needs: change-scope");
    expect(unit).toContain("if: ${{ needs.change-scope.outputs.run_full == 'true' }}");
    for (const job of ["runtime-images", "phase3-real-runtime"]) {
      const body = source.split(`\n  ${job}:`)[1]?.split(/\n {2}[a-z-]+:/)[0];
      expect(body).toContain("needs: unit-and-static");
    }
  });

  it("deploys only after a successful main push quality run or a main manual dispatch", async () => {
    const source = await workflow(deployWorkflowPath);

    expect(source).toContain("workflow_run:");
    expect(source).toContain("workflow_dispatch:");
    expect(source).not.toMatch(/^\s+pull_request:/m);
    expect(source).not.toMatch(/^\s+push:/m);
    expect(source).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(source).toContain("github.event.workflow_run.event == 'push'");
    expect(source).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(source).toContain("github.ref_name == 'main'");
  });

  it("uses a serialized staging environment with least privilege and immutable action pins", async () => {
    const source = await workflow(deployWorkflowPath);
    const actionReferences = [...source.matchAll(/^\s+uses:\s+\S+@(\S+)$/gm)];

    expect(source).toContain("permissions:\n  contents: read");
    expect(source).toContain("group: smedc-staging");
    expect(source).toContain("cancel-in-progress: false");
    expect(source).toContain("name: staging");
    expect(actionReferences.length).toBeGreaterThan(0);
    expect(actionReferences.every((reference) => /^[a-f0-9]{40}$/.test(reference[1] ?? ""))).toBe(
      true
    );
  });

  it("takes secrets only from the staging environment and cleans up the SSH key", async () => {
    const source = await workflow(deployWorkflowPath);

    expect(source).toContain("${{ secrets.ACR_PASSWORD }}");
    expect(source).toContain("${{ secrets.STAGING_CURSOR_SIGNING_SECRET }}");
    expect(source).toContain("${{ secrets.STAGING_SSH_PRIVATE_KEY }}");
    expect(source).toContain("shred --remove");
    expect(source).not.toContain("nick2373262573");
    expect(source).not.toContain("39.96.66.185");
  });
});
