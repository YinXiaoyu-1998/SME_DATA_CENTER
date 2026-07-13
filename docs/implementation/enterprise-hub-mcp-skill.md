# Phase 2 Day 5 Enterprise Hub MCP Meta Skill

This document records the companion skill scope and review checklist for `skills/enterprise-hub-mcp/SKILL.md`.

## Skill Location

- Skill name: `enterprise-hub-mcp`
- Skill file: `skills/enterprise-hub-mcp/SKILL.md`
- UI metadata: `skills/enterprise-hub-mcp/agents/openai.yaml`

The skill is intentionally repo-local and distributable with the project. It is not installed into a personal Codex skill directory by this implementation step.

## Required Behavior

The skill should teach an employee-owned agent how to safely use 企业资料中枢 through MCP. It must keep 企业资料中枢 as a service/tool layer, not an employee-facing AI agent, report generator, dashboard service, or skill execution platform.

The current local-development profile must be actionable enough for an agent to:

1. Collect an already-running Enterprise Hub URL and employee email.
2. Configure only the user-side `mcp:launcher` command.
3. Log in with `enterprise_hub_login_local`; the token remains launcher-memory only.
4. List labels before upload.
5. Upload a local synthetic fixture with existing labels.
6. Check processing status without starting a worker.
7. Search only active API-visible documents.
8. Verify Baoli/Suzhou permission isolation during local testing.
9. List Skill Directory entries as metadata only.

## Profile Boundaries

| Profile             | Day 5 Requirement                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `local-development` | Fully documented with local MCP setup checks and tool flow.                                       |
| `staging-remote`    | Placeholder only; no invented endpoint, credential, token flow, domain, or TLS setting.           |
| `production`        | Placeholder only; no invented production auth, credential, endpoint, or service-account material. |

## Safety Review Checklist

- [x] Skill name is exactly `enterprise-hub-mcp`.
- [x] Skill includes a complete local-development profile.
- [x] Future remote profiles are profiles, not separate skill names.
- [x] Skill contains no real tokens, passwords, customer data, endpoint secrets, or service-account material.
- [x] Skill says MCP tools must use the HTTP API and inherit API authorization.
- [x] Skill forbids direct DB/storage reads for data access.
- [x] Skill forbids exposing raw bearer tokens, session files, or token persistence.
- [x] Skill forbids claiming inaccessible documents exist.
- [x] Skill forbids executing Skill Directory entries.
- [x] Skill forbids report/dashboard generation and direct employee-facing AI behavior.
- [x] Skill requires explicit human authorization before uploading real company documents or customer exports.
- [x] Local human-test docs include a `$enterprise-hub-mcp` fresh-thread prompt.

## Validation

Required checks for Day 5:

```sh
python3 /Users/xiaoyuyin/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/enterprise-hub-mcp
npm run format:check
git diff --check
```

Recommended local confidence check:

```sh
MYSQL_PORT=3307 npm run test:mcp
```

`npm run test:mcp` proves the MCP behavior that the meta skill describes; the skill itself does not add MCP tool behavior.
