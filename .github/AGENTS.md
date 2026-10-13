# GitHub workflows

- Read `deploy/AGENTS.md` for environment, concurrency, deployment and rollback policy; launcher publishing follows `packages/mcp-contract/AGENTS.md`.
- Change classification policy is in `scripts/AGENTS.md`; preserve it in `phase3-quality-gates.yml`.
- Keep real-service/fake-provider CI distinct from actual-provider or official manual acceptance evidence; skipped checks are not passes.
- Preserve pinned action revisions, scoped permissions and separation between PR checks and credentialed release jobs.
- Workflow changes need existing script contract tests: `scripts/quality-gate-scope.test.ts`, `scripts/staging-deploy-workflow.test.ts`, `scripts/runtime-image-contract.test.ts` or release tests as applicable.
