# Phase 3 Readiness Intake

This document tracks human-provided Phase 3 inputs, validation evidence, and per-track readiness for the online-ready service phase.

It is intentionally safe to commit. Do not store secret values here.

## Status Vocabulary

| Status         | Meaning                                                                             |
| -------------- | ----------------------------------------------------------------------------------- |
| `missing`      | Required information has not been provided.                                         |
| `provided`     | Human supplied the information, but no agent has validated it yet.                  |
| `verified`     | Agent validated the information with a non-destructive check and recorded evidence. |
| `blocked`      | Validation failed or the input is unusable; human action is required.               |
| `deferred`     | Human explicitly decided this item is not needed for the current Phase 3 slice.     |
| `not_required` | Item is not required for the named track.                                           |

## Secret Handling Rules

- Never write passwords, access keys, access secrets, JWT/session secrets, private keys, service-account material, or production tokens into this repo.
- For secrets, record only where they are available, for example `local shell env`, `Codex secret env`, `ECS secret env`, or `human secure channel`.
- If an agent needs to validate a secret-backed service, the human must provide the secret through a secure runtime channel, not chat or committed files.
- Verification logs may record command names, non-secret endpoints, bucket names, regions, HTTP status codes, object keys under an approved test prefix, and timestamps.
- Verification logs must not record Authorization headers, signed URLs with credentials, raw token values, secret fingerprints, or full connection strings containing passwords.

## Agent Workflow

When the user provides any Phase 3 input:

1. Read this file, `implementation-plan.md`, `progress.md`, `env-inventory.md`, and `AGENTS.md`.
2. Update the relevant intake row from `missing` to `provided`, or to `deferred` if the human explicitly defers it.
3. If safe credentials are available at runtime, run the smallest non-destructive validation for that item.
4. Record the validation command shape and result in `Verification Log`.
5. Mark the item `verified` only when the validation passed.
6. Update `progress.md` with readiness changes and any blocker changes.
7. Stop before implementing any Phase 3 track whose required inputs are not `verified` or explicitly `deferred`.

## Intake Matrix

| Area            | Item                                    | Status   | Safe Value To Record                                                                                                                                                                                                                     | Secret Location / Handling                        | Validation Required                                                                    | Latest Evidence                                                                                                        |
| --------------- | --------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Deployment      | Deployment target                       | verified | Alibaba Cloud Simple Application Server `Ubuntu-yyht`; instance `98872443e05742f2b64223c7462b268c`; public IP `39.96.66.185`; Ubuntu 22.04; 2 vCPU / 2 GiB RAM / 40 GiB ESSD                                                             | Do not store server credentials                   | Confirm target type, region, access method, and deploy boundary                        | `root` SSH succeeded on 2026-07-05; OS/resources/nginx checked; Docker/Node/npm are missing                            |
| Deployment      | Region / availability zone              | provided | Alibaba Cloud `cn-beijing` / 华北 2（北京）; exact zone not recorded                                                                                                                                                                     | None                                              | Confirm region supports selected services                                              | Region recorded from human-provided console screenshot on 2026-07-05                                                   |
| Deployment      | Runtime shape                           | verified | Single lightweight server using Docker Compose for API and worker containers behind reverse proxy; MCP remains a client-side adapter pointing at the remote API; database must be independent RDS/standalone MySQL, not an app container | Runtime secrets via server env only               | Confirm API, worker, MCP, and database deployment shape                                | Human confirmed Docker/Compose API+worker with independent RDS/MySQL on 2026-07-05; Docker/Compose still not installed |
| Domain/TLS      | Staging domain                          | missing  | Non-secret domain name                                                                                                                                                                                                                   | None                                              | DNS lookup resolves to intended target when configured                                 | Not provided                                                                                                           |
| Domain/TLS      | TLS decision                            | missing  | Managed cert, reverse proxy cert, or deferred                                                                                                                                                                                            | Do not store private key                          | Confirm HTTPS endpoint or documented staging exception                                 | Not provided                                                                                                           |
| Database        | Online MySQL host/port/db/user/SSL mode | missing  | Host, port, db name, username, SSL mode only                                                                                                                                                                                             | Password via secure runtime env only              | Connect with least-privilege credentials and run `SELECT 1`                            | Not provided                                                                                                           |
| Database        | Backup / restore expectation            | missing  | Backup schedule and restore owner                                                                                                                                                                                                        | None                                              | Confirm provider backup setting or documented manual backup runbook                    | Not provided                                                                                                           |
| OSS             | OSS region                              | verified | `oss-cn-beijing`                                                                                                                                                                                                                         | None                                              | Confirm region matches bucket endpoint                                                 | Verified against `https://oss-cn-beijing.aliyuncs.com` on 2026-07-04                                                   |
| OSS             | Original-files bucket                   | verified | Bucket `yxy-tastepal-assets`; approved test prefix `enterprise-hub-readiness/`                                                                                                                                                           | Access key/secret via local `.env` only           | List bucket or stat approved prefix; write tiny test object only under approved prefix | Verified PUT/HEAD/GET/DELETE under approved prefix on 2026-07-04                                                       |
| OSS             | Derived-artifacts bucket or prefix      | missing  | Bucket or prefix decision                                                                                                                                                                                                                | Access key/secret via secure runtime env only     | Confirm bucket/prefix access if Phase 3 uses it                                        | Not provided                                                                                                           |
| OSS             | Endpoint                                | verified | `https://oss-cn-beijing.aliyuncs.com`                                                                                                                                                                                                    | None                                              | Confirm endpoint format and reachability                                               | Verified by signed OSS requests on 2026-07-04                                                                          |
| OSS             | RAM policy                              | verified | Effective permissions verified for `enterprise-hub-readiness/`; formal policy name not recorded                                                                                                                                          | Do not store policy secrets                       | Confirm least-privilege actions cover required put/get/stat/signing behavior           | PUT, HEAD/stat, GET, presigned GET, DELETE succeeded on 2026-07-04                                                     |
| Secrets         | OSS access key/secret                   | verified | Env names only: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`                                                                                                                                                                             | Values are in local `.env`; never commit or print | Validate through OSS check, not by printing values                                     | Credential usability verified by OSS checks on 2026-07-04; values not recorded                                         |
| Secrets         | Online MySQL password                   | missing  | Secret store or runtime env name only                                                                                                                                                                                                    | Never commit; never paste into chat               | Validate through DB connection, not by printing value                                  | Not provided                                                                                                           |
| Secrets         | JWT/session secret                      | missing  | Secret store or runtime env name only                                                                                                                                                                                                    | Never commit; never paste into chat               | Confirm runtime config can read it without logging value                               | Not provided                                                                                                           |
| Auth/Admin      | Allowed admin emails                    | missing  | Email list is safe to record if human approves                                                                                                                                                                                           | None                                              | Confirm each intended admin maps to planned seed/token flow                            | Not provided                                                                                                           |
| Auth/Admin      | Initial employee/label seed policy      | missing  | Synthetic or approved employee/label list                                                                                                                                                                                                | Do not include private HR export                  | Confirm seed plan has no unexpected real data                                          | Not provided                                                                                                           |
| Optional Models | Qwen/DashScope decision                 | missing  | `disabled`, `deferred`, or chosen model/budget                                                                                                                                                                                           | API key via secure runtime env only               | If enabled, validate model/key with minimal metadata call                              | Not provided                                                                                                           |
| Real Data       | Staging document policy                 | missing  | Synthetic-only or explicitly approved real-data scope                                                                                                                                                                                    | Do not commit real documents                      | Confirm allowed test files and retention/deletion policy                               | Not provided                                                                                                           |

## Per-Track Gates

| Phase 3 Track                                  | May Start When                                                                                                                                                             | Current Status | Notes                                                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Day 1 Containerization And Runtime Config      | Deployment target and runtime shape are at least `provided`; required runtime env names are listed without secret values                                                   | ready_partial  | Deployment shape is verified as Docker Compose API+worker with external MySQL; start with Docker/Compose prerequisite setup. |
| Day 2 Aliyun OSS Storage Adapter               | OSS region, endpoint, original bucket, RAM policy, and OSS secret runtime location are `verified`                                                                          | ready          | OSS/S3-compatible access is verified for the approved readiness prefix; implementation still must avoid committing secrets.  |
| Day 3 Online Database And Migration Discipline | Online MySQL host/port/db/user/SSL mode and password runtime location are `verified`; backup expectation is at least `provided`                                            | blocked        | Do not run migrations against an unverified or ambiguous database.                                                           |
| Day 4 Security And Operational Basics          | Deployment/runtime config is at least `provided`; JWT/session secret handling is `verified` or the work is limited to local tests                                          | blocked        | Production auth/token behavior must not rely on invented secrets or admin lists.                                             |
| Day 5 Staging Deployment Runbook               | Deployment target, domain/TLS decision, online MySQL, OSS, JWT/session secret handling, and admin emails are `verified` or explicitly `deferred` where the runbook says so | blocked        | Do not deploy or record staging smoke as passed until the required service checks pass.                                      |

## Validation Playbooks

These are command shapes, not commands to run blindly. Fill variables from secure runtime env or the human-approved shell environment.

### OSS Minimal Validation

Use only an approved test prefix such as `enterprise-hub-readiness/`. Do not upload real documents.

Evidence to record:

- region, endpoint, bucket, prefix
- object key for tiny test object
- put/stat/get/delete or cleanup decision
- timestamp and result

Never record:

- access key
- access secret
- signed URL containing credentials
- Authorization header

### MySQL Minimal Validation

Use the staging database user intended for the app or migration track.

Evidence to record:

- host, port, database name, username, SSL mode
- command shape, for example `mysql --host ... --execute "SELECT 1"`
- timestamp and result

Never record:

- password
- full DSN with password
- exported shell history containing credentials

### Domain/TLS Validation

Evidence to record:

- domain
- DNS result
- HTTP/HTTPS status
- certificate issuer/expiration if public and non-sensitive

Do not store private certificate keys.

### Deployment Target Validation

Evidence to record:

- target type and region
- non-secret account/project identifier if human approves
- whether API, worker, and MCP will run as separate processes/services
- command/tool used for non-destructive access check

Do not store server credentials, SSH keys, cloud access secrets, or private IPs if the human marks them sensitive.

## Verification Log

| Date       | Area                         | Agent / Branch                          | Check                                                                                                                                                                                 | Result                                                                                                                                                                                                      | Follow-up                                                                                                                                 |
| ---------- | ---------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-04 | Phase 3 readiness intake     | `codex/phase3-readiness-intake`         | Created readiness tracker and per-track gate; no external inputs validated                                                                                                            | Pending human inputs                                                                                                                                                                                        | Human should provide the next Phase 3 input through a safe channel, then ask an agent to update and validate this file                    |
| 2026-07-04 | OSS/S3-compatible input      | `codex/phase3-readiness-intake`         | Read non-secret OSS values from local `.env`; confirmed `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are present without recording values                                          | Marked OSS region, endpoint, original bucket, and OSS secret location as `provided`; no network validation run                                                                                              | Need approved test prefix and RAM policy summary, then run non-destructive OSS validation                                                 |
| 2026-07-04 | OSS/S3-compatible validation | `codex/phase3-oss-readiness-verify`     | Used approved prefix `enterprise-hub-readiness/`; PUT tiny text object, HEAD/stat object, GET object, DELETE object, then HEAD after delete                                           | Success: PUT 200, HEAD 200, GET 200 with content match, DELETE 204, final HEAD 404 for `enterprise-hub-readiness/codex-readiness-1783138001251.txt`                                                         | Basic object access verified; object was deleted                                                                                          |
| 2026-07-04 | OSS presigned URL validation | `codex/phase3-oss-readiness-verify`     | PUT tiny text object, generated 60-second presigned GET URL without recording it, fetched through unsigned request, deleted object, then HEAD after delete                            | Success: PUT 200, presigned GET 200 with content match, DELETE 204, final HEAD 404 for `enterprise-hub-readiness/codex-presign-1783138050907.txt`                                                           | Signed download behavior verified; object was deleted                                                                                     |
| 2026-07-05 | Deployment target input      | `codex/phase3-lightsail-readiness`      | Recorded Alibaba Cloud Simple Application Server details from human-provided console screenshot; checked public network reachability for `39.96.66.185`                               | Success: TCP 22, 80, 443, and 3000 are reachable; SSH banner reports `OpenSSH_8.9p1 Ubuntu-3ubuntu0.15`; HTTP on port 80 returns nginx `200 OK`                                                             | Need SSH credentials or an approved secure access method to verify internal OS resources, Docker/Node, disk, and deploy boundary          |
| 2026-07-05 | Deployment SSH access        | `codex/phase3-lightsail-readiness`      | Read password from local untracked `~/.ssh/enterprise-hub-server-password.txt` without printing it; changed file permissions to `600`; attempted password SSH for `root` and `ubuntu` | Blocked: both usernames returned `Permission denied`; no server login occurred and no internal checks ran                                                                                                   | Confirm the correct SSH username/password, whether password login is enabled, and whether the instance needs restart after password reset |
| 2026-07-05 | Deployment internal check    | `codex/phase3-lightsail-readiness`      | Re-read corrected local password file without printing it; password SSH as `root`; ran non-destructive OS/resource/runtime checks                                                     | Success: `root` login; Ubuntu 22.04.5 LTS; kernel 5.15.0-142; 2 CPU; 1608 MiB memory; root disk 40G with 34G available; nginx active; UFW inactive; Docker, Docker Compose, Node, and npm are not installed | Runtime prerequisite setup is needed before deployment; do not deploy until Docker/Node strategy is chosen and recorded                   |
| 2026-07-05 | Deployment runtime strategy  | `codex/phase3-docker-runtime-readiness` | Recorded human decision for Phase 3 runtime strategy                                                                                                                                  | Runtime shape verified: install Docker/Compose on the Alibaba Cloud server; run API and worker as service containers; keep MySQL as independent RDS/standalone MySQL                                        | Need Docker/Compose prerequisite setup and separate RDS/MySQL connection details before deployment                                        |
