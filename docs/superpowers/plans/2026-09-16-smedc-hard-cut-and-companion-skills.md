# SMEDC Hard Cut And Companion Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every current product and tenant-specific identity with SMEDC, publish the renamed launcher, expose organization-backed report naming and a fixed ledger presentation contract, and ship two independently installable companion Skills.

**Architecture:** The main service owns authentication, MCP contracts, launcher packaging, and the versioned ledger presentation profile. The standalone core Skill remains byte-equivalent to the repo-local core Skill. The renamed companion repository contains two self-contained sibling Skills: a tenant-neutral business-analysis Skill and a minimal delivery-ledger Skill with a deterministic CSV exporter and quarantine-photo guidance.

**Tech Stack:** TypeScript 5.9, Fastify, Zod, Prisma/MySQL, Vitest, npm workspaces, Python 3 standard library and `unittest`, GitHub Actions, npm Trusted Publisher, Codex Skills.

**Spec:** `docs/superpowers/specs/2026-09-16-smedc-hard-cut-and-companion-skills-design.md`

## Global Constraints

- The only maintained product name is `SMEDC`; the English expansion is `Small and Medium Enterprises Data Center`.
- This is a one-way hard cut. Do not add old-name aliases, compatibility tools, fallback environment variables, redirect instructions, credential migration, or dual-name documentation.
- The official launcher is `smedc-mcp-launcher@0.5.0`, executable `smedc-mcp-launcher`, MCP entry `smedc`, and base-URL variable `SMEDC_BASE_URL`.
- Staging runtime identities hard-cut to database `smedc`, database user `smedc_app`, ACR namespace `smedc`, runtime root `/opt/smedc`, compose/concurrency name `smedc-staging`, OSS prefixes `smedc/` and `smedc-readiness/`, and Qdrant collection `smedc_evidence`.
- Branded tools are exactly `smedc_login`, `smedc_logout`, `smedc_auth_status`, `smedc_get_current_user`, and `smedc_list_skills`. Existing unbranded business-tool names remain unchanged.
- `smedc_get_current_user.user.organizationName` comes from the authenticated organization record and is the only company-name source for business-report presentation.
- `enterpriseName` remains a structured-data selector. It must not replace or override `organizationName` in report headings.
- The `delivery_ledger` detail profile is exactly `food-purchase-ledger-cn-v1`, title `食品经营单位进货台帐`, with the ten ordered Chinese columns from the approved specification. It excludes `序号`.
- The Ledger CSV is UTF-8 with BOM, contains only the ten profile columns, preserves decimal/telephone strings, uses `YYYY-MM-DD`, protects against spreadsheet formulas, and writes atomically.
- Quarantine-photo operations continue to use the existing `receiptId`, certificate-query, source-download, and archive authorization contracts. Photos never enter the ledger CSV.
- Remove Maijia/麦家 defaults, copy, configuration, store buckets, transformations, tests, and fixtures from current product and Skill surfaces. Do not rewrite immutable Git history.
- Keep `smedc-mcp` focused on MCP installation and generic usage. Dataset-specific ledger presentation/export belongs only in `smedc-delivery-ledger`.
- Install user Skills under `~/.agents/skills`, not `~/.codex/skills`.
- Every non-health service endpoint remains backend-authorized. No client-side organization filtering is trusted.
- Do not commit secrets, `.env`, customer exports, tokens, service-account material, generated reports, SDD ledgers, review packages, or temporary QA data.
- Publish and independently verify launcher 0.5.0 before the server recommends it or either core Skill pins it.
- Stop for explicit human confirmation immediately before GitHub repository renames, workflow disable/enable operations, PR merge, npm publication/tag push, staging deployment, or destructive QA client cleanup.

---

## Subagent-Driven Execution Topology

The root agent is the controller. Implementation subagents run sequentially, even when repositories differ, because all three repositories share one hard-cut contract and the Subagent-Driven Development workflow forbids parallel implementers. Reviewers may start only after the corresponding implementer has stopped and produced its report.

Use these lead branches and fallback worktree paths:

| Repository            | Base                                                                             | Lead branch                       | Worktree path                                                                                       |
| --------------------- | -------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------- |
| Main release boundary | commit `1880cf0` on `codex/smedc-hard-cut-design`                                | `codex/smedc-launcher-release`    | `/Users/xiaoyuyin/Desktop/YXY_DEV/SME_DATA_CENTER/.worktrees/smedc-launcher-release`                |
| Main final hard cut   | latest `codex/smedc-launcher-release`, then rebase onto its merged `origin/main` | `codex/smedc-main-hard-cut`       | `/Users/xiaoyuyin/Desktop/YXY_DEV/SME_DATA_CENTER/.worktrees/smedc-main-hard-cut`                   |
| Core Skill            | verified `origin/main`                                                           | `codex/smedc-core-skill-hard-cut` | `/Users/xiaoyuyin/Desktop/YXY_DEV/enterprise-hub-mcp-skill/.worktrees/smedc-core-skill-hard-cut`    |
| Companion Skills      | verified `origin/main`                                                           | `codex/smedc-companion-skills`    | `/Users/xiaoyuyin/Desktop/YXY_DEV/maijia-business-analyses-smedc/.worktrees/smedc-companion-skills` |

Execution rules:

1. Run `scripts/sdd-workspace docs/superpowers/plans/2026-09-16-smedc-hard-cut-and-companion-skills.md` from the installed Subagent-Driven Development Skill and create its ignored `progress.md` ledger.
2. For Tasks 2–8, create a fresh task branch/worktree from the latest applicable lead-branch head. The implementer owns only that task branch and its named repository.
3. Dispatch each implementer with model `gpt-5.5`, reasoning effort `high`, the generated task brief, exact upstream interfaces, and a report path. Implementers may not create their own subagents.
4. After the implementer commits and reports, generate a review package from the recorded base to task head. Dispatch a fresh task reviewer with `gpt-5.5`, reasoning effort `high`, for both specification compliance and code quality.
5. Resolve Critical/Important findings through the documented fix loop. Integrate Tasks 2–4 into `codex/smedc-launcher-release`; integrate Task 5 into `codex/smedc-main-hard-cut`; integrate Tasks 6–8 into their repository lead branches. Integrate only after review is clean or the five-round breaker has recorded an explicit ruling.
6. Never have two implementation subagents active simultaneously. This prevents two branches from independently redefining package names, tool schemas, profile fields, or installation paths.
7. After Tasks 2–8, dispatch one whole-change reviewer per repository with `gpt-6-astra`, reasoning effort `high`, then one final cross-repository contract reviewer with the same model and effort.
8. The root agent alone performs Tasks 1 and 9–12 because they coordinate branches, external repositories, npm, GitHub, staging, and QA cleanup.

## Task 1: Establish Isolated Worktrees And Baselines

**Files:**

- Modify: `docs/implementation/progress.md`
- Append before each main-repository subagent stops: `docs/implementation/agent-handoffs.md`
- Do not commit: `.superpowers/sdd/2026-09-16-smedc-hard-cut-and-companion-skills/**`

**Interfaces:**

- Consumes: approved spec commit `1880cf0` and clean `origin/main` heads for the two standalone repositories.
- Produces: four clean lead worktrees across three repositories, baseline test evidence, and the SDD ledger used by every later task.

- [ ] **Step 1: Fetch and verify all bases**

Run in each repository:

```bash
git fetch origin --prune
git status --short
git branch --show-current
git rev-parse HEAD
git rev-parse origin/main
```

Expected: all three repositories are clean. The main design worktree is at `1880cf0`; standalone bases match their fetched default branches before lead branches are created.

- [ ] **Step 2: Create the SDD workspace and ledger**

Run the Subagent-Driven Development helper against this plan. The first ledger line must be:

```markdown
# SDD ledger — plan: docs/superpowers/plans/2026-09-16-smedc-hard-cut-and-companion-skills.md
```

Record the three repository base SHAs, the derived main final-hard-cut base, and a preflight table covering every shared interface: organization identity, tool names, package/version, presentation profile, Skill source metadata, and release ordering.

- [ ] **Step 3: Create lead branches in isolated worktrees**

Use `superpowers:using-git-worktrees`. Do not implement in the current design checkout or any repository's `main` branch. Create the four lead branches named in the topology table.

- [ ] **Step 4: Run proportional clean baselines**

Main repository:

```bash
npm run db:generate
npm test
npm run typecheck
npm run lint
npm run format:check
```

Core Skill repository:

```bash
python -m unittest discover -s tests -v
python /Users/xiaoyuyin/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/enterprise-hub-mcp
```

Companion repository:

```bash
python -m unittest discover -s tests -v
python /Users/xiaoyuyin/.codex/skills/.system/skill-creator/scripts/quick_validate.py .
```

Expected: record any pre-existing failure in the ledger before Task 2. Do not silently absorb a baseline failure into later work.

- [ ] **Step 5: Record the start milestone**

Add one concise progress entry with the lead branches, base SHAs, and baseline result. Commit only the progress entry on `codex/smedc-launcher-release`.

## Task 2: Return The Authenticated Organization Name

**Files:**

- Modify: `packages/domain/src/auth.ts`
- Modify: `apps/api/src/auth/auth-core.ts`
- Modify: `apps/api/src/auth/prisma-auth-repository.ts`
- Modify: `apps/api/src/auth/auth-core.test.ts`
- Modify: `apps/api/src/auth/prisma-auth-repository.integration.test.ts`
- Modify: `apps/api/src/app-context.test.ts`
- Modify: `apps/api/src/evidence.test.ts`
- Modify: `apps/api/src/mcp/http.test.ts`
- Modify: `apps/api/src/mcp/upload-tools.test.ts`
- Modify: `apps/api/src/request-auth.test.ts`
- Modify: `apps/api/src/routes/quarantine-certificates.test.ts`
- Modify: `apps/api/src/routes/structured-import/structured-import.test.ts`
- Modify: `apps/api/src/routes/structured-query.test.ts`
- Modify: `apps/api/src/structured-query-route.test.ts`
- Modify: `apps/api/src/structured-query.prisma.integration.test.ts`
- Modify: `apps/api/src/test-support/auth-fixtures.ts`
- Modify: `apps/api/src/routes/system.ts`
- Modify: `apps/api/src/routes/system.test.ts`
- Modify: `apps/api/src/mcp/read-tools.ts`
- Modify: `apps/api/src/mcp/read-tools.test.ts`
- Modify: `packages/mcp-contract/src/index.ts`
- Modify: `packages/mcp-contract/src/index.test.ts`

**Interfaces:**

- Consumes: Prisma relation `Employee.organization` and the existing authenticated access-token flow.
- Produces: `AuthenticatedEmployee.organizationName: string`, `/me.employee.organizationName`, and MCP `user.organizationName`.

- [ ] **Step 1: Write failing authentication and HTTP tests**

Add assertions equivalent to:

```ts
expect(await core.authenticateAccessToken("token", audit)).toMatchObject({
  orgId: "org_1",
  organizationName: "示例餐饮管理有限公司"
});

expect(present.json()).toMatchObject({
  employee: { organizationName: "示例餐饮管理有限公司" }
});
```

The Prisma integration fixture must create an organization with that name and prove it is returned from the joined record, not copied from employee display name or email.

- [ ] **Step 2: Run the focused tests and verify red**

```bash
npm test -- apps/api/src/auth/auth-core.test.ts apps/api/src/auth/prisma-auth-repository.integration.test.ts apps/api/src/routes/system.test.ts
```

Expected: failure because `organizationName` is absent.

- [ ] **Step 3: Extend the authenticated identity types and repository query**

Add `organizationName: string` to `AccessAuthenticationRecord` and `AuthenticatedEmployee`. Include `organization: { select: { name: true } }` in `authenticateAccessToken`, then return `organizationName: token.employee.organization.name`. Propagate it through `AuthCore.authenticateAccessToken` and `employeeResponse`.

- [ ] **Step 4: Write failing MCP projection tests**

Assert the exact successful shape:

```ts
{
  user: {
    displayName: "Current User",
    email: "current@example.com",
    role: "employee",
    clearance: 0,
    organizationName: "示例餐饮管理有限公司"
  }
}
```

Also assert a missing, non-string, or blank organization name causes the existing sanitized MCP API error rather than a fallback name.

- [ ] **Step 5: Implement and verify the MCP contract**

Update the result description and `currentUserFromMe` validation. Trim only to test blankness; return the database value verbatim when nonblank.

```bash
npm test -- apps/api/src/mcp/read-tools.test.ts packages/mcp-contract/src/index.test.ts
npm run typecheck
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit and task-review**

```bash
git add packages/domain/src/auth.ts apps/api/src/auth apps/api/src/routes/system.ts apps/api/src/routes/system.test.ts apps/api/src/mcp/read-tools.ts apps/api/src/mcp/read-tools.test.ts packages/mcp-contract/src/index.ts packages/mcp-contract/src/index.test.ts
git commit -m "feat(auth): expose authenticated organization name"
```

Append the required main-repository handoff before the implementer stops.

## Task 3: Add The Versioned Ledger Presentation Profile

**Files:**

- Modify: `packages/domain/src/structured-registry.ts`
- Modify: `packages/domain/src/structured-registry.test.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `apps/api/src/routes/structured-query.ts`
- Modify: `apps/api/src/routes/structured-query.test.ts`
- Modify: `apps/api/src/structured-query-route.test.ts`
- Modify: `packages/mcp-contract/src/index.ts`
- Modify: `packages/mcp-contract/src/index.test.ts`

**Interfaces:**

- Consumes: existing canonical `delivery_ledger` rows and detail/aggregate query modes.
- Produces: exported `StructuredPresentationProfile`, registry `presentation`, discovery metadata, and detail-query `presentation` response.

- [ ] **Step 1: Write the exact registry test**

The expected profile must be a full deep equality assertion using the ID, title, and ten canonical/display-name pairs from the specification. Add an assertion that `entry_id` and display label `序号` are absent.

- [ ] **Step 2: Write route tests before implementation**

For dataset discovery, assert `delivery_ledger.presentation` equals the profile. For a detail query, assert:

```ts
expect(response.json()).toMatchObject({
  dataset: "delivery_ledger",
  mode: "detail",
  presentation: {
    id: "food-purchase-ledger-cn-v1",
    title: "食品经营单位进货台帐"
  }
});
```

For grouped/aggregate queries, assert no `presentation` key is returned.

- [ ] **Step 3: Run focused tests and verify red**

```bash
npm test -- packages/domain/src/structured-registry.test.ts apps/api/src/routes/structured-query.test.ts apps/api/src/structured-query-route.test.ts
```

- [ ] **Step 4: Implement the domain profile and API response**

Add:

```ts
export interface StructuredPresentationProfile {
  id: string;
  title: string;
  columns: Array<{ canonicalName: string; displayName: string }>;
}
```

Add optional `presentation?: StructuredPresentationProfile` to `StructuredDatasetRegistry`, assign the frozen profile only to `delivery_ledger`, include it in discovery, and include it in `/v1/structured/query` only when `compiled.dataset === "delivery_ledger" && compiled.mode === "detail"`.

- [ ] **Step 5: Synchronize MCP result documentation and verify**

Document the optional presentation block in `query_structured_dataset`'s result shape without changing the input schema.

```bash
npm test -- packages/domain/src/structured-registry.test.ts apps/api/src/routes/structured-query.test.ts apps/api/src/structured-query-route.test.ts packages/mcp-contract/src/index.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit and task-review**

```bash
git add packages/domain/src/structured-registry.ts packages/domain/src/structured-registry.test.ts packages/domain/src/index.ts apps/api/src/routes/structured-query.ts apps/api/src/routes/structured-query.test.ts apps/api/src/structured-query-route.test.ts packages/mcp-contract/src/index.ts packages/mcp-contract/src/index.test.ts
git commit -m "feat(ledger): publish standard Chinese presentation"
```

## Task 4: Rename Workspace, MCP, And Launcher Contracts To SMEDC

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `apps/admin-web/package.json`
- Modify: `apps/api/package.json`
- Modify: `apps/release-ops/package.json`
- Modify: `apps/worker/package.json`
- Modify: `packages/db/package.json`
- Modify: `packages/domain/package.json`
- Modify: `packages/mcp-contract/package.json`
- Modify: `packages/storage/package.json`
- Modify: `packages/structured-ingestion/package.json`
- Modify: `packages/testing/package.json`
- Modify: `tsconfig.base.json`
- Modify: `tsup.release.config.ts`
- Modify: `Dockerfile`
- Modify: TypeScript imports and exported workspace constants under `apps/**/src/**/*.ts`, `packages/**/src/**/*.ts`, and `scripts/**/*.ts`
- Modify: `packages/mcp-contract/src/index.ts`
- Modify: `packages/mcp-contract/src/index.test.ts`
- Modify: `apps/api/src/mcp/read-tools.ts`
- Modify: `apps/api/src/mcp/read-tools.test.ts`
- Modify: `apps/api/src/mcp/tool-handlers.ts`
- Modify: `apps/api/src/mcp/tool-handlers.test.ts`
- Modify: `apps/api/src/mcp/http.ts`
- Modify: `apps/api/src/mcp/http.test.ts`
- Modify: `apps/api/src/mcp/api-delegation.ts`
- Modify: `apps/api/src/mcp/api-delegation.test.ts`
- Modify: `apps/api/src/auth/http-contract.ts`
- Modify: `apps/api/src/auth/http-contract.test.ts`
- Modify: `apps/api/src/request-audit-context.ts`
- Modify: `apps/api/src/request-audit-context.test.ts`
- Modify: `apps/mcp-launcher/package.json`
- Modify: `apps/mcp-launcher/src/config.ts`
- Modify: `apps/mcp-launcher/src/config.test.ts`
- Modify: `apps/mcp-launcher/src/launcher.ts`
- Modify: `apps/mcp-launcher/src/launcher.test.ts`
- Modify: `apps/mcp-launcher/src/oauth-client.ts`
- Modify: `apps/mcp-launcher/src/oauth-client.test.ts`
- Modify: `apps/mcp-launcher/src/server.ts`
- Modify: `apps/mcp-launcher/src/runtime.ts`
- Modify: `apps/mcp-launcher/src/runtime.test.ts`
- Modify: `apps/mcp-launcher/src/session.ts`
- Modify: `apps/mcp-launcher/src/auth.ts`
- Modify: `apps/mcp-launcher/src/auth.test.ts`
- Modify: `apps/mcp-launcher/src/packaging.verify.ts`
- Modify: `apps/mcp-launcher/scripts/keyring-acceptance.mjs`
- Modify: `apps/mcp-launcher/README.md`
- Modify: `.github/workflows/launcher-release.yml`

**Interfaces:**

- Consumes: Tasks 2–3 result shapes.
- Produces: `@smedc/*` workspaces, SMEDC error/type constants, the five branded tool names, and package/binary `smedc-mcp-launcher@0.5.0`.

- [ ] **Step 1: Change contract tests first**

Replace expected branded names with:

```ts
["smedc_login", "smedc_logout", "smedc_auth_status", "smedc_get_current_user", "smedc_list_skills"];
```

Rename exported identifiers such as `ENTERPRISE_HUB_MCP_TOOL_CONTRACTS`, `EnterpriseHubMcpToolName`, and `ENTERPRISE_HUB_API_ERROR` to `SMEDC_MCP_TOOL_CONTRACTS`, `SmedcMcpToolName`, and `SMEDC_API_ERROR`. Add negative assertions proving the former branded tool names are absent.

- [ ] **Step 2: Run contract tests and verify red**

```bash
npm test -- packages/mcp-contract/src/index.test.ts apps/api/src/mcp/read-tools.test.ts apps/api/src/mcp/tool-handlers.test.ts apps/api/src/mcp/http.test.ts apps/mcp-launcher/src/launcher.test.ts
```

- [ ] **Step 3: Apply the exact package map**

Use this map in every manifest, workspace dependency, import, build config, Docker build command, and lockfile entry:

```text
enterprise-hub                         -> smedc
@enterprise-hub/admin-web              -> @smedc/admin-web
@enterprise-hub/api                    -> @smedc/api
@enterprise-hub/release-ops            -> @smedc/release-ops
@enterprise-hub/worker                 -> @smedc/worker
@enterprise-hub/db                     -> @smedc/db
@enterprise-hub/domain                 -> @smedc/domain
@enterprise-hub/mcp-contract           -> @smedc/mcp-contract
@enterprise-hub/storage                -> @smedc/storage
@enterprise-hub/structured-ingestion   -> @smedc/structured-ingestion
@enterprise-hub/testing                -> @smedc/testing
enterprise-hub-mcp-launcher            -> smedc-mcp-launcher
```

Regenerate `package-lock.json` with `npm install --package-lock-only`; do not hand-edit lockfile dependency graphs.

- [ ] **Step 4: Apply the exact MCP/public identifier map**

Rename the five branded tools, TypeScript symbols, safe public error codes, launcher version header, OAuth metadata extension keys, internal delegation header, client ID, and server/service names to `smedc` forms. Do not create accepted old-name aliases. In this release-boundary PR only, keep the recommendation value on the currently published launcher package/version; staging is frozen and Task 12 replaces that transitional value immediately after 0.5.0 registry verification.

- [ ] **Step 5: Bump and verify the launcher package**

Set:

```json
{
  "name": "smedc-mcp-launcher",
  "version": "0.5.0",
  "bin": { "smedc-mcp-launcher": "dist/index.js" }
}
```

Keep repository/homepage/bugs links on `YinXiaoyu-1998/SME_DATA_CENTER`. Update the release workflow workspace, package name, and tag prefix to `smedc-mcp-launcher-v*` while retaining native macOS/Windows acceptance and Trusted Publisher staging.

- [ ] **Step 6: Verify the renamed code contract**

```bash
npm install --package-lock-only
npm run db:generate
npm test -- packages/mcp-contract/src/index.test.ts apps/api/src/mcp apps/mcp-launcher/src
npm run typecheck
npm run build:release
npm run test:package --workspace smedc-mcp-launcher
```

Expected: the launcher lists the five new branded tools and all unbranded business tools, packages successfully as `smedc-mcp-launcher-0.5.0.tgz`, and contains no dependency on `@enterprise-hub/mcp-contract`.

- [ ] **Step 7: Commit and task-review**

Commit the package/contract rename as one release-boundary change:

```bash
git add package.json package-lock.json apps packages scripts tsconfig.base.json tsup.release.config.ts .github/workflows/launcher-release.yml Dockerfile
git commit -m "refactor: hard cut runtime contracts to SMEDC"
```

## Task 5: Rename Runtime, Deployment, Documentation, And Repo-Local Skills

**Files:**

- Rename: `deploy/staging/nginx-enterprise-hub.conf` to `deploy/staging/nginx-smedc.conf`
- Rename: `skills/enterprise-hub-mcp/` to `skills/smedc-mcp/`
- Rename: `skills/enterprise-hub-manual-test/` to `skills/smedc-manual-test/`
- Create: `skills/smedc-business-data-cleanup/SKILL.md` from the existing canonical user Skill with SMEDC names and current schema terminology
- Create: `skills/smedc-business-data-cleanup/agents/openai.yaml`
- Rename: `scripts/enterprise-hub-companion-skill.test.ts` to `scripts/smedc-companion-skill.test.ts`
- Modify: `.env.example`
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `docker/mysql/init/001-grant-prisma-shadow.sql`
- Modify: `deploy/staging/docker-compose.yml`
- Modify: `.github/workflows/phase3-quality-gates.yml`
- Modify: `.github/workflows/staging-deploy.yml`
- Modify: `native/calamine-reader/Cargo.toml`
- Modify: `native/calamine-reader/Cargo.lock`
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `CONTEXT.md`
- Modify: `AGENTS.md`
- Modify: current-state files under `docs/context/**` and `docs/implementation/**`
- Modify: neutral fixture names and their callers under `fixtures/**` and `scripts/**`
- Create: `scripts/check-smedc-naming.ts`
- Create: `scripts/check-smedc-naming.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: Task 4 canonical identifiers.
- Produces: only SMEDC current-state configuration, deployment resources, current docs, repo-local Skills, and neutral fixtures.

- [ ] **Step 1: Add a red naming-policy test**

The checker scans tracked current-state code/config/docs/Skills/fixtures and rejects case-insensitive old product or seed-customer identifiers. Exclude `.git`, `node_modules`, `.data`, `docs/implementation/progress.md`, `docs/implementation/agent-handoffs.md`, dated historical ADR/spec/plan evidence, and the checker's own pattern declaration. Add `npm run check:naming`.

Test the scanner using temporary files with dynamically joined tokens so the scanner source does not self-match:

```ts
const oldProduct = ["enterprise", "hub"].join("-");
const oldTenant = ["mai", "jia"].join("");
```

- [ ] **Step 2: Rename environment and local-runtime identities**

Use `SMEDC_*`, `smedc_*`, `/opt/smedc`, `smedc-staging`, `smedc-api`, `smedc-worker`, `smedc-release-ops`, `smedc-mysql`, `smedc-qdrant`, `smedc_evidence_*`, database/user defaults `smedc`, and Calamine binary `smedc-calamine-reader`. Do not accept old environment variables as fallbacks.

- [ ] **Step 3: Rename the repo-local Skills and operational instructions**

Update frontmatter names, descriptions, `agents/openai.yaml`, internal links, launcher paths, MCP entry, commands, tool names, and companion discovery. The core Skill recommends both `smedc-business-analysis` and `smedc-delivery-ledger` but installs neither without explicit authorization.

- [ ] **Step 4: Neutralize current fixtures and maintained documentation**

Rename files beginning `maijia_` to `synthetic_` equivalents and update manifest/test callers without changing fixture data semantics required by ingestion tests. Replace customer-facing sample names inside maintained fixtures with neutral synthetic organizations where doing so does not invalidate the fixture's source-format purpose.

Historical progress and handoff evidence may retain old names. Current commands, current release status, installation instructions, operational runbooks, API contracts, acceptance procedures, and examples must use only SMEDC.

- [ ] **Step 5: Verify current-state naming and repo-local Skills**

```bash
npm run check:naming
npm test -- scripts/check-smedc-naming.test.ts scripts/smedc-companion-skill.test.ts scripts/manual-test-fixtures.test.ts
python /Users/xiaoyuyin/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/smedc-mcp
python /Users/xiaoyuyin/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/smedc-manual-test
npm run typecheck
npm run lint
npm run format:check
git diff --check
```

- [ ] **Step 6: Commit and task-review**

```bash
git add -A
git commit -m "docs: complete the SMEDC hard-cut rename"
```

The reviewer must distinguish allowed immutable history from actionable current-state references.

## Task 6: Rename And Synchronize The Standalone Core Skill

**Files in the standalone core-Skill repository:**

- Rename: `skills/enterprise-hub-mcp/` to `skills/smedc-mcp/`
- Modify: `skills/smedc-mcp/SKILL.md`
- Modify: `skills/smedc-mcp/agents/openai.yaml`
- Modify: `skills/smedc-mcp/references/update-skill.md`
- Modify: `README.md`
- Modify: `README.zh.md`
- Rename: `tests/test_companion_guidance.py` to `tests/test_smedc_skill_contract.py`
- Modify: `tests/test_smedc_skill_contract.py`

**Interfaces:**

- Consumes: Task 5's final `skills/smedc-mcp/` bytes and Task 4 launcher/tool contract.
- Produces: standalone repository content byte-equivalent to the repo-local Skill and ready for repository rename to `smedc-mcp-skill`.

- [ ] **Step 1: Replace tests with the new exact contract**

Assert `smedc-mcp`, `smedc-mcp-launcher@0.5.0`, `SMEDC_BASE_URL`, MCP entry `smedc`, the five branded tools, both companion names/links, `organizationName`, and absence of silent companion installation. Assert former product and tenant names are absent from current repository files.

- [ ] **Step 2: Copy the reviewed repo-local Skill as the authority**

Remove the old Skill directory, copy the complete main-repository `skills/smedc-mcp/` directory, and update standalone bilingual packaging/install documentation. Do not maintain divergent hand edits between the two Skill copies.

- [ ] **Step 3: Validate byte equality and tests**

```bash
diff -ru /Users/xiaoyuyin/Desktop/YXY_DEV/SME_DATA_CENTER/.worktrees/smedc-main-hard-cut/skills/smedc-mcp skills/smedc-mcp
python -m unittest discover -s tests -v
python /Users/xiaoyuyin/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/smedc-mcp
git diff --check
```

- [ ] **Step 4: Commit and task-review**

```bash
git add -A
git commit -m "refactor: rename the core Skill to SMEDC"
```

## Task 7: Restructure And Genericize The Business-Analysis Skill

**Files in the companion repository:**

- Move: `SKILL.md` to `skills/smedc-business-analysis/SKILL.md`
- Move: `agents/openai.yaml` to `skills/smedc-business-analysis/agents/openai.yaml`
- Rename/move: `config/maijia.json` to `skills/smedc-business-analysis/config/business-analysis.json`
- Move: `references/report_style.zh.md` to `skills/smedc-business-analysis/references/report_style.zh.md`
- Move: `scripts/*.py` to `skills/smedc-business-analysis/scripts/`
- Move: existing `tests/**` to `skills/smedc-business-analysis/tests/**`
- Move: `requirements-dev.txt` to `skills/smedc-business-analysis/requirements-dev.txt`
- Modify: `README.md`
- Modify: `README.zh.md`
- Create: `scripts/validate_all_skills.py`
- Create: `.github/workflows/test.yml`

**Interfaces:**

- Consumes: `smedc_get_current_user.user.organizationName`, existing SMEDC dataset coverage/download contracts, and existing report behavior.
- Produces: independently installable `smedc-business-analysis` with no tenant defaults.

- [ ] **Step 1: Restructure without behavior changes and repair test paths**

Move the existing Skill into `skills/smedc-business-analysis/`. Update every `ROOT`, fixture, config, and script path so this subtree can be copied alone and its tests run from either the repository root or Skill directory.

- [ ] **Step 2: Write red organization-name and tenant-removal tests**

Add fixture identity data:

```json
{
  "user": {
    "displayName": "测试员工",
    "email": "qa@example.invalid",
    "role": "employee",
    "clearance": 3,
    "organizationName": "示例餐饮管理有限公司"
  }
}
```

Assert all report `<h1>` titles contain `示例餐饮管理有限公司`, no report/config/current fixture contains the removed seed-customer names, and blank `organizationName` exits nonzero with a business-readable account-organization error.

- [ ] **Step 3: Make organization name an explicit report input**

Extend the run/profile/render pipeline with one field named `organization_name`. Populate it only from the saved result of `smedc_get_current_user`. Thread it through bundle metadata and HTML generation; do not infer it from filenames, partitions, stores, or enterprise selectors.

- [ ] **Step 4: Remove tenant-specific configuration and transformations**

Delete the default company object, English seed-customer name, hard-coded large/small store buckets, seed-customer text stripping, and any report module that exists only to express those buckets. Retain generic period, coverage, aggregation, trend, product, chart, partial-data, empty-report, and scratch-cleanup behavior.

- [ ] **Step 5: Rewrite Skill metadata and installation guidance**

The Skill depends on `smedc-mcp`, checks for that prerequisite before data access, offers the official core installation only with explicit authorization, and never installs its sibling Ledger Skill automatically.

- [ ] **Step 6: Add repository-wide validation**

`scripts/validate_all_skills.py` discovers immediate directories under `skills/`, runs Skill validation for each, verifies each subtree is self-contained, and runs each Skill's tests. The workflow uses supported Python and invokes this script.

- [ ] **Step 7: Run the complete business-analysis suite**

```bash
python -m unittest discover -s skills/smedc-business-analysis/tests -v
python scripts/validate_all_skills.py
python /Users/xiaoyuyin/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/smedc-business-analysis
git diff --check
```

- [ ] **Step 8: Commit and task-review**

```bash
git add -A
git commit -m "refactor: make SMEDC business analysis tenant neutral"
```

## Task 8: Add The Delivery-Ledger Skill And CSV Exporter

**Files in the companion repository:**

- Create: `skills/smedc-delivery-ledger/SKILL.md`
- Create: `skills/smedc-delivery-ledger/agents/openai.yaml`
- Create: `skills/smedc-delivery-ledger/config/food-purchase-ledger-cn-v1.json`
- Create: `skills/smedc-delivery-ledger/scripts/export_ledger_csv.py`
- Create: `skills/smedc-delivery-ledger/tests/test_export_ledger_csv.py`
- Create: `skills/smedc-delivery-ledger/tests/fixtures/ledger-pages.json`
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `.github/workflows/test.yml`

**Interfaces:**

- Consumes: Task 3 profile metadata and existing unbranded quarantine-certificate tools.
- Produces: independently installable `smedc-delivery-ledger` and CLI `export_ledger_csv.py INPUT_JSON OUTPUT_CSV [--overwrite]`.

- [ ] **Step 1: Create the exact local profile**

Write the ID, title, and ordered canonical/display pairs byte-for-byte from the specification. The config contains no `序号`, no receipt metadata columns, and no optional alternate labels.

- [ ] **Step 2: Write exporter tests before the script**

Cover:

```python
self.assertEqual(headers, [
    "食品名称", "规格", "进货数量", "进货金额", "生产日期或生产批号",
    "保质期", "供货单位名称", "供货单位地址", "供货单位联系方式", "进货日期",
])
```

Also test one-page and multi-page inputs, UTF-8 BOM, row order, `None` to empty string, string decimals, a `+86...` phone, all four formula prefixes, date validation, wrong dataset/mode/profile, missing fields, non-scalar values, existing-output rejection, `--overwrite`, and absence of a partial output after failure.

- [ ] **Step 3: Verify the tests fail**

```bash
python -m unittest discover -s skills/smedc-delivery-ledger/tests -p 'test_export_ledger_csv.py' -v
```

- [ ] **Step 4: Implement the standard-library exporter**

Use `argparse`, `json`, `csv`, `tempfile`, and `os.replace`. Accept one result object or an array of result objects. Validate every page before creating the temporary output. Quote through `csv.writer`; prefix risky spreadsheet strings with a single quote; never parse decimals or telephone values as numbers.

- [ ] **Step 5: Write the concise Ledger Skill**

The Skill instructs agents to discover the dataset/profile, select the ten fields in order, paginate bounded user scope, render display names verbatim, and use the exporter only for CSV requests. It maps “对账单编号”, “单据号”, and “收货单号” to `receiptId` and documents upload/query/download/single-archive/admin-bulk-archive behavior without OCR or authenticity claims.

- [ ] **Step 6: Validate the new Skill and repository**

```bash
python -m unittest discover -s skills/smedc-delivery-ledger/tests -v
python scripts/validate_all_skills.py
python /Users/xiaoyuyin/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/smedc-delivery-ledger
git diff --check
```

- [ ] **Step 7: Commit and task-review**

```bash
git add skills/smedc-delivery-ledger README.md README.zh.md .github/workflows/test.yml
git commit -m "feat: add the SMEDC delivery ledger Skill"
```

## Task 9: Run Whole-Repository And Cross-Repository Review Gates

**Files:**

- Modify only when review finds a concrete defect: the owning repository's task-scoped files.
- Update milestone only: `docs/implementation/progress.md`

**Interfaces:**

- Consumes: reviewed lead branches from Tasks 2–8.
- Produces: three PR-ready branches with synchronized contracts and no unresolved load-bearing findings.

- [ ] **Step 1: Run the main-repository final gates once**

```bash
npm run db:generate
npm run check:naming
npm run audit:production
npm run build:release
npm run test:package --workspace smedc-mcp-launcher
npm test
npm run typecheck
npm run lint
npm run format:check
MYSQL_PORT=3307 npm run test:integration
MYSQL_PORT=3307 npm run test:mcp
npm run test:phase3:golden
npm run test:phase3:perf
git diff --check
```

Load the real local `.env` provider configuration for the required real-provider focused smoke, then remove `.data` artifacts and repository-owned Docker resources and verify cleanup as required by `AGENTS.md`.

- [ ] **Step 2: Run both standalone repository gates**

```bash
python -m unittest discover -s tests -v
python /Users/xiaoyuyin/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/smedc-mcp
git diff --check
```

```bash
python scripts/validate_all_skills.py
python -m unittest discover -s skills/smedc-business-analysis/tests -v
python -m unittest discover -s skills/smedc-delivery-ledger/tests -v
git diff --check
```

- [ ] **Step 3: Verify cross-repository contracts**

```bash
diff -ru /Users/xiaoyuyin/Desktop/YXY_DEV/SME_DATA_CENTER/.worktrees/smedc-main-hard-cut/skills/smedc-mcp /Users/xiaoyuyin/Desktop/YXY_DEV/enterprise-hub-mcp-skill/.worktrees/smedc-core-skill-hard-cut/skills/smedc-mcp
rg -n -i 'enterprise[-_ ]hub|maijia|麦家' /Users/xiaoyuyin/Desktop/YXY_DEV/enterprise-hub-mcp-skill/.worktrees/smedc-core-skill-hard-cut /Users/xiaoyuyin/Desktop/YXY_DEV/maijia-business-analyses-smedc/.worktrees/smedc-companion-skills
```

Expected: byte-identical core Skills and no old-name match in current standalone repository contents. Main historical evidence exclusions must match Task 5's checker policy.

- [ ] **Step 4: Dispatch whole-branch and cross-repository reviewers**

Create one complete diff package per lead branch. Dispatch three repository reviewers and then one cross-repository reviewer with `gpt-6-astra`, `high`. The cross-repository review must verify exact tool names, organization field, package/version, Skill source links, profile bytes, installer paths, and release ordering.

- [ ] **Step 5: Prepare PR descriptions and diff composition**

Each PR description includes scope, tests, environment changes, human decisions, limitations, dependencies, and approximate insertions/deletions separated into production/config, runtime/CI/deploy, tests/harnesses, documentation, and lockfile. Flag this implementation plan and SDD artifacts as process-only; include the plan in a PR only because the user explicitly requested it, and never include the ignored SDD workspace.

## Task 10: Perform The Authorized Repository-Rename And Release Preparation Gate

**Files/external state:**

- GitHub repositories: `YinXiaoyu-1998/SME_DATA_CENTER`, `YinXiaoyu-1998/enterprise-hub-mcp-skill`, `YinXiaoyu-1998/maijia-business-analyses-smedc`
- GitHub Actions workflow: `staging-deploy.yml`
- npm Trusted Publisher for `smedc-mcp-launcher`

**Interfaces:**

- Consumes: PR-ready reviewed branches and explicit human confirmation at this external-mutation gate.
- Produces: renamed Skill repositories, updated remotes/publisher trust, and staging frozen on the last known-good release. The main service repository intentionally retains its existing `SME_DATA_CENTER` name.

- [ ] **Step 1: Stop and request explicit confirmation**

Report exact current repository names, intended names, open PR heads, current staging release SHA, and the fact that staging auto-deploy will be temporarily disabled. Do not rename, disable, merge, tag, or publish before confirmation.

- [ ] **Step 2: Disable staging auto-deploy and record state**

After confirmation, use `gh workflow disable staging-deploy.yml --repo YinXiaoyu-1998/SME_DATA_CENTER`, then verify it is disabled. Record the currently running staging image/release SHA without printing secrets.

- [ ] **Step 3: Rename repositories and update remotes**

Verify `gh repo rename --help`, then rename exactly:

```text
YinXiaoyu-1998/enterprise-hub-mcp-skill         -> YinXiaoyu-1998/smedc-mcp-skill
YinXiaoyu-1998/maijia-business-analyses-smedc   -> YinXiaoyu-1998/smedc-companion-skills
```

Update each local `origin`, fetch, and verify default branch, branch protection, environments, variables, and secrets names without exposing values.

- [ ] **Step 4: Configure and verify npm Trusted Publisher**

Set the publisher to repository `YinXiaoyu-1998/SME_DATA_CENTER` and workflow `.github/workflows/launcher-release.yml`. If npm requires an interactive owner-only console action that cannot be completed safely by the agent, stop with only that exact action requested; do not ask for an npm token.

## Task 11: Merge The Release Boundary And Publish Launcher 0.5.0

**Files/external state:**

- Main service PR
- npm package `smedc-mcp-launcher@0.5.0`

**Interfaces:**

- Consumes: Task 10 confirmation and staging freeze.
- Produces: the Tasks 2–4 release-boundary code on `main` and an independently verified public launcher package, while staging remains on the old release. Task 5 and both standalone repository branches remain unmerged until verification completes.

- [ ] **Step 1: Merge only the reviewed release-boundary PR**

The PR contains Tasks 2–4 and the committed approved specification/plan, but not Task 5's repo-local Skill pins or current release-status documentation. Verify required checks, report diff composition, and merge only after explicit human confirmation. Confirm staging did not deploy because its workflow is disabled.

- [ ] **Step 2: Publish through the push-triggered reviewed workflow**

The merge to `main` triggers `.github/workflows/launcher-release.yml`. Wait according to the repository's three-minute external-blocker policy. Verify the native macOS/Windows acceptance and publish jobs succeed. Do not create a second tag-triggered publication run unless the workflow failed before publication and its documented recovery specifically requires one.

- [ ] **Step 3: Independently verify the registry artifact**

In a fresh temporary directory:

```bash
npm view smedc-mcp-launcher@0.5.0 version
npm install --prefix ./install --save-exact smedc-mcp-launcher@0.5.0
./install/node_modules/.bin/smedc-mcp-launcher --version
npm audit --omit=dev --prefix ./install --audit-level=moderate
```

Pack the registry artifact and the merged workspace artifact, extract both, and require `diff -qr` equality. Delete the temporary directory afterward.

## Task 12: Synchronize Pins, Deploy, Reinstall QA, And Accept The Hard Cut

**Files:**

- Modify in main: `apps/api/src/auth/http-contract.ts`
- Modify in main: `apps/api/src/auth/http-contract.test.ts`
- Modify in main: `skills/smedc-mcp/SKILL.md`
- Modify in core Skill repository: `skills/smedc-mcp/SKILL.md`
- Modify current release-status documentation in all three repositories
- Modify milestone records: `docs/implementation/progress.md`, `docs/implementation/staging-readiness.md`

**Interfaces:**

- Consumes: independently verified `smedc-mcp-launcher@0.5.0`.
- Produces: server recommendation and Skills pinned to the available package, deployed staging, and clean QA acceptance evidence.

- [ ] **Step 1: Update recommendation metadata and both core Skill pins**

Set package `smedc-mcp-launcher`, minimum/recommended version values according to the hard-cut contract, and exact install paths for 0.5.0. Keep the repo-local and standalone Skill directories byte-identical.

- [ ] **Step 2: Re-run focused and release gates, review, and merge synchronization PRs**

Run auth metadata tests, launcher packaging tests, Skill validation, byte comparison, and each repository's static tests. Report diff composition and stop for explicit confirmation before merging.

- [ ] **Step 3: Provision the SMEDC-named staging resources**

Keep staging frozen. Through approved Alibaba Cloud CLI/OpenAPI where supported, create database `smedc` and least-privilege user `smedc_app` on the existing RDS instance. Store the new password only in secure runtime storage and the local operator Keychain service `com.smedc.rds.smedc_app`; never print it. Update the GitHub staging environment's approved non-secret namespace/path variables and its existing secrets without revealing secret values.

ACR Personal Edition requires the owner to create namespace `smedc` and repositories `api` and `worker` in the console if they do not exist; request only that one-time console action. Configure the runtime for OSS prefixes `smedc/` and `smedc-readiness/`, Qdrant collection `smedc_evidence`, and server root `/opt/smedc`. Apply Prisma migrations and deterministic non-customer seed data to the new empty database. Do not copy QA business data from the old database, OSS prefix, or Qdrant collection.

- [ ] **Step 4: Re-enable and dispatch staging deployment**

Enable `staging-deploy.yml` in `YinXiaoyu-1998/SME_DATA_CENTER`, then dispatch a deploy from `main`. Verify health, readiness boundary, image SHA, OAuth metadata package/version, and that the service exposes the SMEDC branded tool contract.

- [ ] **Step 5: Destructively reset only the QA client state**

After explicit confirmation, remove the old QA MCP entry, old installed Skills, old launcher application-support directory, and old secure-store credential. Preserve unrelated MCP entries, Skills, credentials, and user data. Install only:

```text
~/.agents/skills/smedc-mcp
~/.agents/skills/smedc-business-analysis
~/.agents/skills/smedc-delivery-ledger
```

Configure MCP entry `smedc` with `SMEDC_BASE_URL=https://api.smedatacenter.xyz` and the exact 0.5.0 launcher path.

- [ ] **Step 6: Run focused official QA acceptance**

Use a fresh synthetic account with organization name `SMEDC QA 示例餐饮管理有限公司`. In separate ordinary user-visible tasks, verify:

1. installation, browser login, and `smedc_get_current_user.organizationName`;
2. a business report whose company name is exactly the organization name;
3. a delivery-ledger query whose table uses the exact title and ten Chinese columns;
4. CSV export including BOM, order, null, phone, decimal, date, quoting, and formula protection;
5. quarantine-photo upload, explicit receipt query, original download URL, single archive, and admin receipt-level archive;
6. absence of the old MCP entry, old Skills, and old current-user launcher state.

- [ ] **Step 7: Clean all QA and local residue**

Hard-delete the synthetic account after removing run-scoped documents, imports, ledger rows, certificates, OSS objects, Qdrant points, audit references, local downloads, generated CSV, launcher session, and temporary files. Verify zero residue with the official cleanup tooling and repository-required Docker/worktree checks.

- [ ] **Step 8: Retire old QA-only staging resources**

After successful acceptance and one final read-only inventory, request explicit confirmation for irreversible retirement. Then remove the old QA-only database/user, old OSS objects under the retired product prefix, old Qdrant collection/volume, old `/opt/enterprise-hub` runtime directory, and old ACR repositories/images when the provider permits it. Preserve the approved RDS backup/snapshot and Git/npm/GitHub release history; they are recovery/history artifacts, not compatibility surfaces.

- [ ] **Step 9: Record final evidence and finish branches**

Update progress/readiness with merged PRs, package integrity, staging SHA, acceptance results, cleanup evidence, and any explicit rulings. Remove clean inactive worktrees, run `git worktree prune`, and use `superpowers:finishing-a-development-branch` for each repository.
