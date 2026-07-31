# Runtime Image And Dependency Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove development tooling from the long-running API and worker images, preserve release operations in an ephemeral image, clear all non-ExcelJS production high/critical advisories, and enforce the approved six-month ExcelJS exception plus explicit moderate-risk records.

**Architecture:** Bundle the API, worker loop, readiness utility, and staging smoke with tsup. Install service-specific production dependency closures for the API and worker, while a separate Compose-profiled `release-ops` image owns Prisma migration, Qdrant initialization, and compiled staging smoke. A tested policy evaluator consumes npm-audit and Trivy JSON and accepts only exact, unexpired risk-register entries.

**Tech Stack:** Node.js 22, npm workspaces, TypeScript, tsup/esbuild, Vitest, Prisma 7, Docker Buildx, Docker Compose, Trivy, GitHub Actions, Markdown.

## Global Constraints

- Keep ExcelJS 4.4.0 for this change; do not add a transitive override or downgrade to ExcelJS 3.4.0.
- The ExcelJS exception expires on `2027-01-31` and covers only the read-only XLSX dependency path recorded in the risk register.
- Fail production dependency and image gates on every critical, every unregistered high, every expired exception, and every unregistered moderate.
- Upgrade Fastify to `5.11.0` and the three Prisma packages plus Prisma CLI to `7.9.1`; preserve existing HTTP, database, and worker behavior.
- Long-running API and worker images must not contain `tsx`, `typescript`, `vitest`, `eslint`, `prettier`, or the Prisma CLI.
- Build API and worker production closures with `npm ci --omit=dev --legacy-peer-deps`, scoped to the applicable workspace; this is required to prevent Prisma optional peers from restoring development packages.
- `release-ops` is ephemeral, uses the existing API ACR repository tag `ops-<12-character-git-sha>`, and is never started by ordinary Compose `up`.
- Scan API, worker, and release-operations images. The worker must pass without any ExcelJS exception.
- Do not deploy staging from this implementation branch. Verification may build and scan local `linux/amd64` images.
- This plan and the audit-provenance plan are delivered through one main-repository PR; no standalone skill repository change is needed.

---

### Task 1: Executable dependency and image risk policy

**Files:**

- Create: `config/dependency-risk-acceptance.json`
- Create: `scripts/check-vulnerability-policy.ts`
- Create: `scripts/check-vulnerability-policy.test.ts`
- Create: `docs/implementation/dependency-risk-register.md`
- Modify: `package.json`

**Interfaces:**

- Produces: `npm run audit:production`, which runs npm audit against `https://registry.npmjs.org` and validates its JSON.
- Produces: `npm run audit:report -- --kind trivy --component <component> --input <file>`, which validates Trivy JSON.
- Consumes: exact exception IDs, packages, components, approval date, and review deadline from `config/dependency-risk-acceptance.json`.
- Preserves: npm audit exit code `1` as parseable vulnerability output; malformed audit JSON or tool execution errors still fail closed.

- [ ] **Step 1: Add failing policy fixtures in the unit test**

Use in-memory npm-audit and Trivy payloads. Cover exact acceptance, a new high, an expired exception, a broadened package match, an unregistered moderate, and the worker attempting to use the ExcelJS exception:

```ts
expect(evaluateNpmAudit(excelJsAudit, policy, new Date("2026-08-01T00:00:00Z"))).toMatchObject({
  ok: true
});
expect(evaluateNpmAudit(unknownHighAudit, policy, now)).toMatchObject({ ok: false });
expect(evaluateNpmAudit(excelJsAudit, policy, new Date("2027-02-01T00:00:00Z"))).toMatchObject({
  ok: false
});
expect(evaluateTrivy(workerExcelJsReport, policy, "worker-image", now)).toMatchObject({
  ok: false
});
expect(evaluateTrivy(unregisteredModerateReport, policy, "api-image", now)).toMatchObject({
  ok: false
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run scripts/check-vulnerability-policy.test.ts
```

Expected: failure because the evaluator and policy file do not exist.

- [ ] **Step 3: Implement the typed fail-closed evaluator**

Export these pure interfaces/functions for tests:

```ts
export type RiskComponent =
  "repository-production" | "api-image" | "worker-image" | "release-ops-image";

export interface PolicyResult {
  ok: boolean;
  accepted: string[];
  violations: string[];
  registeredModerates: string[];
}

export function evaluateNpmAudit(report: unknown, policy: RiskPolicy, now: Date): PolicyResult;

export function evaluateTrivy(
  report: unknown,
  policy: RiskPolicy,
  component: RiskComponent,
  now: Date
): PolicyResult;
```

For npm audit, recursively resolve string-valued `via` references until they reach advisory objects. An ancestor is accepted only when every reachable advisory and every ancestor package is in the same exact exception. For Trivy, match vulnerability ID, package name, component, and deadline. Critical findings are never accepted.

- [ ] **Step 4: Record the exact ExcelJS exception and human explanation**

Use one machine-readable exception:

```json
{
  "schemaVersion": 1,
  "exceptions": [
    {
      "id": "exceljs-read-only-xlsx-2026-07",
      "rootPackage": "exceljs",
      "components": ["repository-production", "api-image", "release-ops-image"],
      "allowedPackages": [
        "exceljs",
        "archiver",
        "archiver-utils",
        "brace-expansion",
        "glob",
        "minimatch",
        "readdir-glob",
        "rimraf",
        "uuid",
        "zip-stream"
      ],
      "advisories": [
        {
          "id": "GHSA-mh99-v99m-4gvg",
          "package": "brace-expansion",
          "severity": "high"
        },
        {
          "id": "GHSA-w5hq-g745-h8pq",
          "package": "uuid",
          "severity": "moderate"
        }
      ],
      "approvedOn": "2026-07-31",
      "reviewBy": "2027-01-31"
    }
  ],
  "moderates": []
}
```

In the Markdown register, explain the affected XLSX read path, authenticated uploads, 50 MiB decoded cap, ZIP-entry/expansion/path/duplicate limits, row/sheet/cell limits, why replacement is deferred, owner `Enterprise Hub maintainers`, early-review trigger, and `read-excel-file` as the leading replacement candidate. Do not describe the exception as blanket acceptance of ExcelJS or ZIP parsing.

- [ ] **Step 5: Wire CLI scripts and verify GREEN**

Add:

```json
{
  "audit:production": "tsx scripts/check-vulnerability-policy.ts npm-audit",
  "audit:report": "tsx scripts/check-vulnerability-policy.ts report"
}
```

The npm-audit mode must spawn:

```text
npm audit --omit=dev --registry=https://registry.npmjs.org --json
```

Run:

```bash
npx vitest run scripts/check-vulnerability-policy.test.ts
npm run audit:production
```

Expected before Task 2: the unit test passes; the live audit still fails specifically for the current Fastify/Prisma findings.

- [ ] **Step 6: Commit**

```bash
git add config/dependency-risk-acceptance.json scripts/check-vulnerability-policy.ts scripts/check-vulnerability-policy.test.ts docs/implementation/dependency-risk-register.md package.json
git commit -m "feat(security): enforce dependency risk policy"
```

### Task 2: Compatible dependency upgrades and locked production audit

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `apps/api/package.json`
- Modify: `apps/worker/package.json`

**Interfaces:**

- Produces: Fastify `5.11.0`, Prisma CLI/client/adapter `7.9.1`, and `@fastify/multipart` `10.1.0` in the lockfile.
- Produces: explicit `dotenv` runtime dependencies in API and worker instead of relying on root-workspace hoisting.
- Preserves: ExcelJS `4.4.0` and all public API/database behavior.

- [ ] **Step 1: Capture the pre-upgrade failing audit and focused baselines**

Run:

```bash
npm run audit:production
npx vitest run apps/api/src/server.test.ts apps/api/src/auth/routes.test.ts apps/api/src/auth/schema.test.ts
```

Expected: the audit rejects `GHSA-c96f-x56v-gq3h` and current Prisma moderates; focused behavior tests pass.

- [ ] **Step 2: Update only the compatible package lines**

Run:

```bash
npm install --save-exact fastify@5.11.0 @fastify/multipart@10.1.0 @prisma/adapter-mariadb@7.9.1 @prisma/client@7.9.1 --workspace @enterprise-hub/api
npm install --save-exact @prisma/adapter-mariadb@7.9.1 @prisma/client@7.9.1 --workspace @enterprise-hub/worker
npm install --save-exact dotenv@17.4.2 --workspace @enterprise-hub/api
npm install --save-exact dotenv@17.4.2 --workspace @enterprise-hub/worker
npm install --save-dev --save-exact prisma@7.9.1
npm install
npm run db:generate
```

Do not run `npm audit fix --force`.

- [ ] **Step 3: Verify the dependency graph and policy**

Run:

```bash
npm ls fastify find-my-way prisma @prisma/client @prisma/adapter-mariadb exceljs
npm run audit:production
```

Expected: no critical; no high outside `GHSA-mh99-v99m-4gvg`; the only retained moderate is the registered ExcelJS `uuid` advisory unless the refreshed lockfile removes it. If any other moderate remains, add an exact entry with impact, mitigation, owner, and review date before the gate may pass.

- [ ] **Step 4: Run focused behavior tests**

Run:

```bash
npx vitest run apps/api/src/server.test.ts apps/api/src/auth/routes.test.ts apps/api/src/auth/schema.test.ts apps/api/src/mcp/http.test.ts
npm run typecheck
```

Expected: all pass without contract changes.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json apps/api/package.json apps/worker/package.json config/dependency-risk-acceptance.json docs/implementation/dependency-risk-register.md
git commit -m "chore(deps): clear non-ExcelJS production advisories"
```

### Task 3: Compiled service and release-operation entrypoints

**Files:**

- Create: `tsup.release.config.ts`
- Create: `scripts/release-build.test.ts`
- Modify: `package.json`

**Interfaces:**

- Produces: `dist/release/api.js`, `dist/release/worker.js`, `dist/release/readiness.js`, and `dist/release/staging-smoke.js`.
- Bundles: internal `@enterprise-hub/*` TypeScript.
- Externalizes: third-party packages and native modules so npm/Trivy retain an auditable runtime inventory.

- [ ] **Step 1: Write a failing release-build contract test**

The test imports `releaseEntries` and asserts:

```ts
expect(releaseEntries).toEqual({
  api: "apps/api/src/index.ts",
  worker: "apps/worker/src/dev-loop.ts",
  readiness: "scripts/readiness.ts",
  "staging-smoke": "scripts/staging-smoke.ts"
});
```

It then runs `npm run build:release`, asserts all four `.js` artifacts exist under the ignored `dist/release/` directory, and verifies none imports an `@enterprise-hub/` source path at runtime.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run scripts/release-build.test.ts
```

Expected: failure because the release config and command do not exist.

- [ ] **Step 3: Add the release build**

Add root `tsup@8.5.1` as an explicit dev dependency and:

```json
{
  "build:release": "tsup --config tsup.release.config.ts"
}
```

Configure:

```ts
export const releaseEntries = {
  api: "apps/api/src/index.ts",
  worker: "apps/worker/src/dev-loop.ts",
  readiness: "scripts/readiness.ts",
  "staging-smoke": "scripts/staging-smoke.ts"
} as const;

export default defineConfig({
  entry: releaseEntries,
  format: ["esm"],
  outDir: "dist/release",
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: [/^@enterprise-hub\//]
});
```

Keep third-party packages external. Confirm native Argon2, Prisma engines, OSS, MySQL, and Qdrant imports remain runtime dependencies.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npx vitest run scripts/release-build.test.ts
npm run build:release
node --check dist/release/api.js
node --check dist/release/worker.js
node --check dist/release/readiness.js
node --check dist/release/staging-smoke.js
```

- [ ] **Step 5: Commit**

```bash
git add tsup.release.config.ts scripts/release-build.test.ts package.json package-lock.json
git commit -m "build: compile service release entrypoints"
```

### Task 4: Lean long-running images and ephemeral release operations

**Files:**

- Modify: `Dockerfile`
- Modify: `deploy/staging/docker-compose.yml`
- Create: `apps/release-ops/package.json`
- Modify: `package-lock.json`
- Create: `scripts/runtime-image-contract.test.ts`

**Interfaces:**

- Produces Docker targets: `api`, `worker`, and `release-ops`.
- Produces Compose service: `release-ops` with `profiles: ["release"]`.
- Preserves long-running service names, non-root execution, host network, health check, and environment.

- [ ] **Step 1: Write failing Docker/Compose contract assertions**

Test the parsed source contracts:

```ts
expect(dockerfile).toContain('CMD ["node", "dist/release/api.js"]');
expect(dockerfile).toContain('CMD ["node", "dist/release/worker.js"]');
expect(dockerfile).toContain("FROM manifests AS release-ops-deps");
expect(dockerfile).toContain("FROM runtime-base AS release-ops");
expect(compose).toContain('profiles: ["release"]');
expect(compose).toContain("${ENTERPRISE_HUB_RELEASE_OPS_IMAGE}");
expect(apiSection).not.toContain("npm run api:dev");
expect(workerSection).not.toContain("npm run worker:dev");
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run scripts/runtime-image-contract.test.ts
```

Expected: current Dockerfile uses `tsx` development commands and Compose lacks `release-ops`.

- [ ] **Step 3: Implement service-specific dependency stages**

Use manifest-only install stages before copying source:

```dockerfile
RUN npm ci --omit=dev --legacy-peer-deps \
  --workspace @enterprise-hub/api --include-workspace-root=false
```

and the matching worker command. Copy generated `.prisma` client/runtime artifacts from the build stage. API runtime copies only API production dependencies plus `dist/release/api.js`; worker runtime copies only worker production dependencies plus `dist/release/worker.js`.

Create a private `@enterprise-hub/release-ops` workspace whose production dependencies are `@enterprise-hub/api@0.0.0` and `prisma@7.9.1`. Install it in a dedicated stage:

```dockerfile
FROM manifests AS release-ops-deps
RUN npm ci --omit=dev --legacy-peer-deps \
  --workspace @enterprise-hub/release-ops --include-workspace-root=false
```

This supplies the API/storage/Prisma runtime closure plus Prisma CLI without copying the root test/lint toolchain. The final target must start from `runtime-base`, not the source-bearing build stage; run compiled utilities with `node`; and copy only:

- `dist/release/readiness.js`;
- `dist/release/staging-smoke.js`;
- root `package.json`;
- `packages/db/prisma.config.ts`;
- `packages/db/prisma/`;
- the two staging evidence fixtures;
- generated Prisma runtime and the runtime dependencies needed by those commands.

- [ ] **Step 4: Add the Compose release profile**

Add:

```yaml
release-ops:
  image: ${ENTERPRISE_HUB_RELEASE_OPS_IMAGE}
  profiles: ["release"]
  network_mode: host
  env_file:
    - ${ENTERPRISE_HUB_RUNTIME_ENV_FILE:-/opt/enterprise-hub/runtime.env}
  environment:
    NODE_ENV: production
```

Do not add `restart`, ports, or a dependency that starts it during ordinary rollout.

- [ ] **Step 5: Build and inspect local images**

Run:

```bash
docker build --target api -t enterprise-hub-api:runtime-hardening .
docker build --target worker -t enterprise-hub-worker:runtime-hardening .
docker build --target release-ops -t enterprise-hub-release-ops:runtime-hardening .
docker run --rm --entrypoint sh enterprise-hub-api:runtime-hardening -c 'test ! -e node_modules/tsx && test ! -e node_modules/typescript && test ! -e node_modules/vitest && test ! -e node_modules/prisma'
docker run --rm --entrypoint sh enterprise-hub-worker:runtime-hardening -c 'test ! -e node_modules/tsx && test ! -e node_modules/typescript && test ! -e node_modules/vitest && test ! -e node_modules/prisma && test ! -e node_modules/exceljs'
docker run --rm --entrypoint sh enterprise-hub-release-ops:runtime-hardening -c 'test ! -e node_modules/vitest && test ! -e node_modules/eslint && test ! -e node_modules/prettier && test -e node_modules/prisma'
docker compose -f deploy/staging/docker-compose.yml config --quiet
```

Expected: all pass; ordinary Compose config does not schedule `release-ops`.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npx vitest run scripts/runtime-image-contract.test.ts scripts/release-build.test.ts
```

Then:

```bash
git add Dockerfile deploy/staging/docker-compose.yml apps/release-ops/package.json package-lock.json scripts/runtime-image-contract.test.ts
git commit -m "build: split lean runtime and release ops images"
```

### Task 5: Three-image release, scanning, migration, and smoke flow

**Files:**

- Modify: `scripts/deploy-staging.ts`
- Modify: `scripts/deploy-staging.test.ts`
- Modify: `.github/workflows/phase3-quality-gates.yml`
- Modify: `.github/workflows/staging-deploy.yml`
- Modify: `config/dependency-risk-acceptance.json`
- Modify: `docs/implementation/dependency-risk-register.md`

**Interfaces:**

- Produces: `releaseOpsImageReference(..., tag)` returning the API repository sibling tag `ops-${tag}`.
- Persists: `ENTERPRISE_HUB_RELEASE_OPS_IMAGE` in runtime release metadata.
- Uses: `compose --profile release run -T --rm release-ops ...` for Qdrant init, Prisma migration, and staging smoke.
- Preserves: API/worker rollback semantics; release-ops is not rolled back as a running service.

- [ ] **Step 1: Extend deploy tests and verify RED**

Add:

```ts
expect(
  releaseOpsImageReference("registry.example.com", "enterprise-hub", "api", "0123456789ab")
).toBe("registry.example.com/enterprise-hub/api:ops-0123456789ab");
expect(rollout).toContain("compose --profile release run -T --rm release-ops");
expect(rollout).not.toContain("compose run -T --rm api npm run db:migrate:deploy");
expect(smokeCommand).toContain("node dist/release/staging-smoke.js");
```

Also assert all remote Compose jobs end with `</dev/null`, and rollback metadata parsing remains data-only.

Run:

```bash
npx vitest run scripts/deploy-staging.test.ts
```

- [ ] **Step 2: Build, push, and scan all three images**

Extend `buildAndPush` and `scanImages` to include `release-ops`. Trivy must emit JSON for `MEDIUM,HIGH,CRITICAL`, then invoke the policy evaluator:

```text
trivy image --scanners vuln --severity MEDIUM,HIGH,CRITICAL --format json --output <temp> --platform linux/amd64 <image>
npm run audit:report -- --kind trivy --component <component> --input <temp>
```

Do not use `--ignore-unfixed`. Delete temporary reports in `finally` without printing environment secrets. Add each observed retained image moderate to the machine-readable and human risk registers with exact vulnerability ID, package, component, impact, mitigation, owner, and review date; otherwise this step remains red.

- [ ] **Step 3: Move operational commands out of API**

The rollout script must set all three immutable image variables and run:

```bash
compose --profile release run -T --rm release-ops node dist/release/readiness.js init-qdrant </dev/null
compose --profile release run -T --rm release-ops npm run db:migrate:deploy </dev/null
```

The smoke path must run:

```bash
docker compose --profile release --env-file /opt/enterprise-hub/runtime.env \
  -f /opt/enterprise-hub/docker-compose.yml run -T --rm release-ops \
  node dist/release/staging-smoke.js </dev/null
```

Record the ops image in `current-release.env` and `previous-release.env`, but restore only API and worker processes during rollback.

- [ ] **Step 4: Add pull-request security gates**

In `phase3-quality-gates.yml`, add a dependency-policy step after `npm ci`. Add a `runtime-images` job that builds all three `linux/amd64` targets, installs pinned Trivy `v0.72.0`, scans them through the policy evaluator, and depends on `unit-and-static`.

Keep the staging workflow using the same canonical `npm run deploy:staging`; do not duplicate release logic in YAML.

- [ ] **Step 5: Verify deploy behavior**

Run:

```bash
npx vitest run scripts/deploy-staging.test.ts scripts/staging-deploy-workflow.test.ts scripts/check-vulnerability-policy.test.ts
npm run deploy:staging -- --dry-run
bash -n <(node --import tsx -e 'import { remoteScriptsForValidation } from "./scripts/deploy-staging.ts"; process.stdout.write(remoteScriptsForValidation().join("\\n"))')
```

Expected: dry-run reports API, worker, and ops image references; remote scripts parse; no command uses API as a migration/smoke container.

- [ ] **Step 6: Commit**

```bash
git add scripts/deploy-staging.ts scripts/deploy-staging.test.ts .github/workflows/phase3-quality-gates.yml .github/workflows/staging-deploy.yml config/dependency-risk-acceptance.json docs/implementation/dependency-risk-register.md
git commit -m "ci: gate and release hardened images"
```

### Task 6: Runtime documentation and full verification

**Files:**

- Modify: `docs/implementation/staging-deploy-runbook.md`
- Modify: `docs/implementation/server-runtime-prerequisites.md`
- Modify: `docs/implementation/env-inventory.md`
- Modify: `docs/implementation/test-cases.md`
- Modify: `docs/implementation/progress.md`

**Interfaces:**

- Documents: three image targets, one existing API repository with `ops-<sha>`, Compose release profile, risk policy, six-month review, local verification, and rollback behavior.
- Preserves: current staging secrets, repository names, and canonical deploy command.

- [ ] **Step 1: Update operator documentation**

Explain that:

- API and worker are long-running lean images;
- `release-ops` is an on-demand profile only;
- no new ACR repository or secret is required;
- Prisma migration is forward-only and is not reversed by image rollback;
- ExcelJS review is due `2027-01-31`;
- new high/critical or unregistered moderate findings block CI.

Do not record a deployment tag because this branch is not deployed.

- [ ] **Step 2: Run the complete repository gates**

Load the ignored real provider configuration without printing it:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
set -a; source .env; set +a; MYSQL_PORT=3307 npm run test:integration
MYSQL_PORT=3307 npm run test:mcp
npm run test:phase3:golden
npm run test:phase3:perf
npm run audit:production
git diff --check
```

- [ ] **Step 3: Build and scan the final local artifacts**

Run the same `linux/amd64` build and policy commands used by CI for:

- `api-image`;
- `worker-image`;
- `release-ops-image`.

Then start the local runtime with disposable MySQL/Qdrant data and prove:

- API health succeeds;
- private readiness succeeds;
- worker starts and handles termination;
- release-ops initializes Qdrant;
- release-ops applies migrations against the disposable database;
- release-ops runs compiled staging smoke against the disposable local API by setting `STAGING_SMOKE_API_URL=http://127.0.0.1:3000`, creates only synthetic fixtures, completes upload/index/search, and removes those fixtures;
- all containers run as the non-root `node` user.

- [ ] **Step 4: Record final evidence and commit**

Update `progress.md` once with the completed workstream, exact commands/results, no-staging-deploy statement, and PR readiness.

```bash
git add docs/implementation/staging-deploy-runbook.md docs/implementation/server-runtime-prerequisites.md docs/implementation/env-inventory.md docs/implementation/test-cases.md docs/implementation/progress.md
git commit -m "docs: record runtime hardening verification"
```
