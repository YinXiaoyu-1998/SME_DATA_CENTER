# Cloud, runtime images and staging

Applies to deployment/host tasks and root Docker/runtime configuration as well as this directory.

- Prefer Alibaba Cloud CLI/OpenAPI for authorized cloud work. Inspect product help before mutation; use SSH or OS tools for host-level checks.
- ACR Personal Edition has no OpenAPI for console-only resource mutation. Give the human exact targets for those changes, then continue with CLI/docker verification.
- Never request AccessKey secrets in chat or expose credentials in commands, logs, PRs, or repository files. Store non-secret readiness facts in `docs/implementation/staging-readiness.md`.
- Before host changes read `docs/implementation/server-runtime-prerequisites.md` and `docs/implementation/staging-readiness.md`. Use the account-owned Beijing ACR; do not configure unapproved registry mirrors.
- The canonical release is `npm run deploy:staging` through the GitHub `staging` Environment after `main` quality gates. PRs never deploy; local deployment is only for explicitly approved recovery/diagnosis.
- Staging workflows use the `smedc-staging` concurrency group. Rollback restores the previous image and never reverses Prisma migrations.

- Read `docs/implementation/staging-deploy-runbook.md` for execution details. Align API, worker and release-ops image contents with `Dockerfile`, `tsup.release.config.ts` and workspace dependency manifests.
- Preserve worker-specific Calamine/LibreOffice/font runtime dependencies and existing image/renderer checks when changing packaging. `apps/release-ops/package.json` is an operational image dependency boundary, not an employee API.
