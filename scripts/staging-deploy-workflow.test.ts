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
    const images = source.split("\n  runtime-images:")[1]?.split("\n  phase3-real-runtime:")[0];
    expect(images).toContain("needs: [change-scope, unit-and-static]");
    expect(images).toContain("if: ${{ needs.change-scope.outputs.run_images == 'true' }}");
    for (const job of ["phase3-real-runtime"]) {
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

it("cancels only obsolete PR checks and retains all permission/integration gates", async () => {
  const source = await workflow(qualityWorkflowPath);
  expect(source).toContain(
    "group: smedc-quality-${{ github.event.pull_request.number || github.run_id }}"
  );
  expect(source).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  for (const command of [
    "npm test",
    "npm run test:integration",
    "RUN_DATABASE_PROTOCOL_INTEGRATION=1",
    "RUN_LEDGER_PRISMA_INTEGRATION=1"
  ])
    expect(source).toContain(command);
});

it("caches each runtime target and hands off only tested main images to the matching run", async () => {
  const quality = await workflow(qualityWorkflowPath);
  const deploy = await workflow(deployWorkflowPath);
  for (const target of ["api", "worker", "release-ops"]) {
    expect(quality).toContain(`cache-from: type=gha,version=2,scope=smedc-${target}`);
    expect(quality).toContain(`cache-to: type=gha,version=2,scope=smedc-${target},mode=max`);
  }
  expect(quality).toContain("retention-days: 1");
  expect(quality).toContain("overwrite: true");
  expect(quality).toContain("compression-level: 0");
  expect(quality).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
  expect(quality).toContain("smedc-runtime-images-${{ github.sha }}\n");
  expect(deploy).toContain("run-id: ${{ github.event.workflow_run.id }}");
  expect(deploy).toContain("smedc-runtime-images-${{ github.event.workflow_run.head_sha }}\n");
  expect(deploy).toContain("SMEDC_PREBUILT_IMAGE_DIRECTORY:");
  const buildxStep = deploy.split("- name: Set up Docker Buildx")[1]?.split("\n      - name:")[0];
  expect(buildxStep).toContain(
    "github.event_name == 'workflow_dispatch' && inputs.operation == 'deploy'"
  );
});

it("runs all native launcher release checks only for an explicit version tag or manual release", async () => {
  const release = await workflow(join(repoRoot, ".github/workflows/launcher-release.yml"));
  const triggers = release.split("\npermissions:")[0];
  expect(triggers).not.toContain("branches:");
  expect(triggers).not.toContain("paths:");
  expect(release).toContain('"smedc-mcp-launcher-v*"');
  expect(release).toContain("workflow_dispatch:");
  for (const os of ["macos-latest", "windows-latest", "ubuntu-latest"])
    expect(release).toContain(os);
});

it("keeps the public static host separate from authenticated API and business pages", async () => {
  const api = await readFile(join(repoRoot, "deploy/staging/nginx-smedc.conf"), "utf8");
  const site = await readFile(join(repoRoot, "deploy/staging/nginx-marketing.conf"), "utf8");
  const bootstrap = await readFile(
    join(repoRoot, "deploy/staging/nginx-marketing-bootstrap.conf"),
    "utf8"
  );
  expect(api).toContain("server_name api.smedatacenter.xyz;");
  expect(api).toContain("proxy_pass http://127.0.0.1:3000;");
  expect(api).toMatch(/location = \/readyz\s*\{\s*return 404;/);
  expect(site).not.toContain("proxy_pass");
  expect(site).toContain("root /opt/smedc/marketing/current;");
  expect(site).toContain("return 301 https://smedatacenter.xyz$request_uri;");
  expect(site).toContain("location / { return 404; }");
  expect(site).not.toContain("try_files $uri /index.html");
  expect(bootstrap).toContain("/.well-known/acme-challenge/");
  expect(bootstrap).not.toContain("ssl_certificate");
});
