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
    expect(source).toContain('paths-ignore:\n      - "docs/**"');
    expect(source).not.toContain('"**/*.md"');
    expect(source).not.toContain('"fixtures/**"');
    expect(source).toContain('"skills/**/*.md"');
    expect(source).toContain("pull_request:");
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

describe("quality gate cost controls", () => {
  it("keeps PR checks visible and cancels only superseded PR runs", async () => {
    const source = await workflow(qualityWorkflowPath);
    expect(source).toContain(
      "group: quality-${{ github.event.pull_request.number || github.run_id }}"
    );
    expect(source).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(source).toContain("pull_request:\n  push:");
    expect(source).toContain("fetch-depth: 0");
    expect(source).toContain("PR_BASE_SHA: ${{ github.event.pull_request.base.sha }}");
    expect(source).toContain("PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}");
    expect(source).toContain('git diff --check "$PR_BASE_SHA...$PR_HEAD_SHA"');
    expect(source).toContain("name: Unit mocks and static checks");
  });

  it("keeps Node image checks independent of parser tests and omits PDF image qualification", async () => {
    const source = await workflow(qualityWorkflowPath);
    const images = source.split("  runtime-images:")[1]?.split("  phase3-real-runtime:")[0];
    expect(images).toContain("needs: unit-and-static");
    expect(images).toContain("if: needs.unit-and-static.outputs.node_images == 'true'");
    expect(images).not.toContain("pdf");
    expect(source).not.toContain("test-pdf-container.py");
    expect(source).not.toContain("Build PDF parser image");
    expect(source).toContain("pytest tests -q");
    expect(source).toContain("if: needs.unit-and-static.outputs.integration == 'true'");
    expect(source).toContain("if: needs.unit-and-static.outputs.pdf == 'true'");
  });

  it("caches each image separately but refreshes security layers and retains scanners", async () => {
    const source = await workflow(qualityWorkflowPath);
    for (const target of ["api", "worker", "release-ops"]) {
      expect(source).toContain(`cache-from: type=gha,scope=ci-${target}`);
      expect(source).toContain(`cache-to: type=gha,scope=ci-${target},mode=`);
    }
    expect(source.match(/no-cache-filters: runtime-base/g)).toHaveLength(3);
    expect(source.match(/pull: true/g)).toHaveLength(3);
    expect(source).toContain("Report runtime image advisories");
    expect(source).toContain('DOCKER_BUILD_RECORD_UPLOAD: "false"');
  });

  it("keys only download caches and verifies restored models before use", async () => {
    const source = await workflow(join(repoRoot, ".github/actions/pdf-dependencies/action.yml"));
    expect(source).toContain("runner.arch");
    expect(source).toContain("services/pdf-parser/uv.lock");
    expect(source).toContain("services/pdf-parser/model-notices.json");
    expect(source).not.toContain("restore-keys:");
    expect(source).not.toContain("path: services/pdf-parser/.venv");
    expect(source).toContain("uv sync --python 3.12.14 --locked");
    expect(source).toContain(
      "prepare_models --cache .codex-build/pdf-ci/model-cache --output .codex-build/pdf-ci/models"
    );
  });
});
