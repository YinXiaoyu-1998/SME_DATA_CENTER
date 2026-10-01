# Quality gate cost controls

`Phase 3 quality gates` retains its existing check names. PR selection compares the
entire PR against its merge base, including deleted paths and both sides of renames.
A missing/invalid diff fails the initial check; unknown file categories select all
checks. No GitHub file-list API limit is involved.

- Documentation-only PRs run checkout, selection and whitespace validation, without
  installing npm dependencies or starting images/databases/OCR. Markdown evidence
  under `fixtures/` is runtime input and never treated as documentation.
- Other PRs keep the complete Node unit/static suite. Node runtime changes select
  all three Node images; parser-only changes can skip those images. PDF parser,
  contract, worker, storage and release changes select Python/OCR and PDF
  integration tests. Changes to workflows, dependency locks or unknown build inputs
  select everything.
- Only superseded runs of the same PR are cancelled. Main push and manual runs
  always run all routine checks; documentation-only main pushes retain the existing
  workflow exclusion, narrowed to documentation paths so Markdown evidence fixtures
  still trigger full main checks. Deployment serialization and release gates are unchanged.
- GitHub reports intentionally skipped jobs as skipped; the always-running
  `Unit mocks and static checks` job must succeed before dependent jobs run.

Docker builds use separate GitHub cache scopes per target. Base images are still
pulled and runtime OS update layers always rebuilt. Node image vulnerability
reporting remains in place. The quality workflow does not build, scan or run the
PDF Docker image, including on main pushes and manual dispatches. Build-record
artifact uploads are disabled because these checks do not consume them.

PDF caches contain uv downloads and public, manifest-selected model files, never
credentials, private PDFs, parser results or virtual environments. Keys include
platform/lock identity for dependencies and both manifests for models. Restored
models are always copied through the existing size/SHA verification before use.
There are no broad model restore keys.

Caches use the repository's existing Actions cache quota; no storage budget is
increased. Eviction or a cold cache may cause downloads/rebuilds. Savings must be
measured from successful GitHub runs, not inferred from local execution. A
manual workflow dispatch runs all routine checks on a PR branch when needed.

PDF image building and OS/Python vulnerability reporting remain in the staging
release pipeline; rollout checks parser readiness when PDF processing is enabled.
The synthetic offline OCR/container qualification in `scripts/test-pdf-container.py`
remains available for explicit runtime qualification on a suitably provisioned
Linux/Docker host. It is not automatically run by quality checks or deployment.
Its container isolation, timeout and OOM checks require this separate acceptance;
passing Python tests alone does not establish final-image qualification.
