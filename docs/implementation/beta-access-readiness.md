# First Beta User Readiness

Last verified: 2026-08-23

This document tracks whether Enterprise Hub is ready for a first controlled beta user. It replaces
the withdrawn 2026-07-23 beta-token bridge snapshot; do not use any design that asks a user or
agent to handle passwords, JWTs, opaque tokens, refresh credentials, or raw HTTP headers.

“Real beta user” and “real customer data” remain separate gates. A real beta user may test the
live staging service with fixture or explicitly approved non-sensitive business documents before
the project is ready to ingest customer-confidential or authoritative production data.

## Current Answer

Enterprise Hub is ready for a **controlled macOS + Codex beta pilot with non-sensitive data**.

It is **not yet ready for real customer data**. Recovery, alerts, retention/deletion policy, and
selected operational drills still need owner approval and evidence before customer-confidential
data is uploaded.

Windows and OpenClaw are intentionally not blocking the first macOS + Codex pilot. They remain
separate acceptance gates before claiming broad desktop-agent support.

## Verified Current Facts

| Boundary              | Current evidence                                                                                           | Result                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Public service        | `https://api.smedatacenter.xyz/healthz`                                                                    | `200`                                                                                                  |
| Private readiness     | public `GET /readyz`                                                                                       | `404`, as designed; readiness remains internal only                                                    |
| Official identity     | browser password setup/login, OAuth Device Authorization, rotating durable credentials                     | deployed to staging; 0.1.x Authorization Code + PKCE remains server-compatible only                    |
| Development auth      | old dev email/JWT login and staging JWT secret                                                             | removed from staging runtime/GitHub/local Keychain                                                     |
| Public MCP            | unauthenticated public `/mcp`                                                                              | rejects unauthenticated requests; authenticated launcher calls succeed                                 |
| Launcher package      | public npm package `enterprise-hub-mcp-launcher@0.4.0`                                                     | exact install, native macOS/Windows package acceptance, registry integrity, packaging, and audit pass. |
| macOS Codex client    | 0.1.x user-visible flow plus 0.3.0 native package acceptance                                               | passed at those scopes; full user-visible 0.3.0 rerun is not yet recorded                              |
| Full macOS Codex flow | fresh synthetic account, 11 natural user-visible Codex sessions, upload/search/query/logout/reset/re-login | passed core auth/evidence lifecycle; structured-query usability observations remain                    |
| Cleanup               | manual acceptance cleanup                                                                                  | removed run documents, import batch, Qdrant points, dish rows, identity, employee, session             |
| Deployment            | GitHub `main` quality gates and staging deploy workflow                                                    | successful deployment observed at immutable tag `bbb227421fa5`                                         |
| Runtime               | API/worker/Qdrant/nginx/TLS/RDS/OSS                                                                        | healthy in the latest verified live checks                                                             |
| RDS backup            | 7-day full backup retention and 7-day log backup                                                           | backup exists; restore has not been rehearsed                                                          |
| RDS transport         | private VPC TCP; provider SSL disabled                                                                     | current staging fact; final SSL policy remains open                                                    |
| RDS lifecycle         | prepaid RDS expiry and deletion-protection facts recorded in staging readiness                             | human renewal/protection decision still required before customer data                                  |

The earlier headless Linux loop remains compatibility evidence; it was not rerun against 0.3.0.

## First Pilot Scope

The recommended first pilot is:

- one real beta user;
- macOS + Codex only;
- official skill installation and `enterprise-hub-mcp-launcher@0.4.0`;
- browser password setup and Device Authorization login only;
- fixture or explicitly approved non-sensitive documents;
- one or a few simple visibility labels;
- evidence document upload/search as the primary workflow;
- structured CSV upload/query only with the tightened skill guidance and explicit date/import
  context.

The first pilot should avoid real customer-confidential data, broad multi-user rollout, Windows,
OpenClaw, admin UI, MFA, self-service registration, and automated password-reset email.

## Remaining Before Inviting The First macOS + Codex Beta User

| Item                            | Status                | Why it matters                                                                                                                           |
| ------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Beta onboarding runbook         | covered by this slice | The operator needs one repeatable path for account creation, setup-link delivery, verification, reset, and deletion.                     |
| Skill structured-query guidance | covered by this slice | Manual acceptance showed low-technical prompts like “this table” can cause an agent to answer from a local CSV or query historical rows. |
| Actual beta identity details    | needed per user       | Operator needs email, display name, role, organization, and allowed labels for the real beta user.                                       |
| First-run data approval         | needed per pilot      | Decide whether the user uses repo fixtures, synthetic internal docs, or a specific non-sensitive real document.                          |
| Support owner/contact           | needed per pilot      | Someone must own setup-link delivery, first-login support, reset, and cleanup during the pilot.                                          |

No additional ACR, SSH, RDS password, OSS key, domain, TLS, GitHub Actions secret, npm token, or
JWT secret is required for the first macOS + Codex pilot.

## Known Product/UX Observations From Manual Acceptance

1. A vague structured prompt such as “this table” may lead an agent to inspect a locally attached
   CSV instead of calling Enterprise Hub. The skill must instruct employee-owned agents to use
   Enterprise Hub MCP for Enterprise Hub questions, and to treat local files only as upload inputs
   unless the employee explicitly asks for local-file inspection.
2. An unbounded structured query can return older authorized rows from the same dataset. For
   recently uploaded tables, the agent should bind follow-up questions to the import result,
   declared business-date window, enterprise name, or other returned metadata; if that context is
   absent, it should ask a short clarification instead of querying all historical data.
3. Evidence search should continue to use explicit filters such as label and, when testing a fresh
   upload, returned document ids. This avoids matching historical fixture uploads while still
   proving the new upload was indexed and searchable.

These observations are not security bypasses: backend authorization continued to enforce employee
scope. They are beta-readiness usability issues because a low-technical user expects “刚上传这份表”
to refer to that upload, not all accessible history or an agent-side local shortcut.

## Human Inputs Required For The First Beta User

| Input                  | Why it is needed                            | Recommended default                                  |
| ---------------------- | ------------------------------------------- | ---------------------------------------------------- |
| Beta email             | login identity and setup-link recipient     | real beta email                                      |
| Display name           | operator clarity and audit readability      | real name or agreed nickname                         |
| Organization           | backend tenant boundary                     | current staging org, unless a new org is intentional |
| Role                   | backend authorization role                  | `employee`                                           |
| Allowed labels         | document/query visibility                   | one personal label plus explicit store/team labels   |
| First-run data class   | prevents accidental customer-data upload    | fixture or approved non-sensitive internal document  |
| Support/reset contact  | account setup and recovery during the pilot | repository operator                                  |
| Pilot success criteria | determines whether the pilot is done        | install, login, upload, search, logout/reset         |

## Before Real Customer Data

The following are not blockers for a fixture/non-sensitive first pilot, but they are blockers before
customer-confidential or production-authoritative data is uploaded:

- approve RPO/RTO and rehearse at least one restore/recovery path;
- configure minimal uptime, disk, worker-failure, and RDS-expiry alerts;
- run one controlled application rollback drill;
- record retention/deletion policy for originals, derived rows, vectors, and audit records;
- decide RDS renewal/deletion-protection policy;
- triage the root dependency audit separately from the clean launcher install audit and passing
  fixable-critical image scan;
- decide whether RDS SSL policy should change from private VPC TCP to provider SSL enforcement.

## Pilot Acceptance Gates

A first macOS + Codex beta pilot passes only when:

- the beta user installs or repairs the skill/launcher without seeing command-line internals as a
  required manual step;
- account password setup and login occur only in the Enterprise Hub browser page;
- no password, setup link, token, credential, header, or full DSN appears in chat, config, git,
  logs, or reports;
- the launcher stores durable authentication in the operating-system secure store;
- a new Codex task can list authenticated labels and call Enterprise Hub MCP tools;
- fixture or approved non-sensitive evidence upload, indexing, and search succeed;
- any structured follow-up query is scoped to the intended upload/window or asks for clarification;
- logout and operator password reset revoke old access;
- pilot test data can be deleted or clearly retained under the agreed policy.
