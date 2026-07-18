# Natural-language Manual Acceptance Design

Date: 2026-07-18
Status: approved by the product owner in the preceding review

## Problem

The first manual suite mixed controller guardrails and protocol terminology into employee-client prompts. Those runs prove a guided MCP conformance path, but they do not prove that an ordinary cold-start user can obtain the right behavior without telling Codex how the system works.

## Decision

Make natural cold-start behavior the primary manual acceptance suite. Keep protocol, safety, authorization, and state expectations in the controller oracle and automated tests, never in the employee's message.

The controller must send each manifest prompt verbatim. It must not prepend a boundary prompt, mention the expected answer, name tools or protocols, or tell the employee-client how to encode, authorize, query, or reject data.

## Natural prompt contract

Employee prompts may contain only information a local-development employee plausibly supplies:

- the development login email, because production SSO does not exist yet;
- the assigned fixture path, as a local proxy for attaching a file;
- ordinary business intent such as “只让保利店同事看到” or a date range.

Employee prompts must not contain:

- English controller boundaries or `$enterprise-hub-mcp` instructions;
- MCP, Base64, raw-byte, label-key, visibility-scope, idempotency-key, SQL, or controlled-query terminology;
- grounding, permission, prompt-injection, validation, atomicity, or expected-answer hints;
- instructions not to inspect source, logs, Docker, MySQL, Qdrant, storage, or workers.

At least the cold-search questions must not name Enterprise Hub, MCP, or any specific tool. Discovering and using the appropriate installed capability is part of the acceptance result.

## Scenario structure

Keep four fresh, user-visible tasks:

1. A Baoli employee naturally uploads the Baoli SOP and a second untrusted discount document.
2. A Suzhou employee naturally uploads the conflicting SOP and asks the store's green-pepper rule.
3. A fresh Baoli employee asks the meat-sandwich question, an unsupported lamb-pao-mo question, and the discount-code question.
4. A Baoli employee naturally uploads a known-value sales CSV, asks business aggregations, then tries a malformed CSV.

Upload and cold search remain separate tasks so the search participant has not read the answer fixture. The conflicting Suzhou document must exist before the Baoli cold-search task.

## Controller and oracle responsibilities

The controller, not the employee prompt, owns:

- clean local MySQL/Qdrant/storage setup and service lifecycle;
- task order, identity expectations, fixture assignment, and exact-byte comparison;
- label, idempotency, authorization, query-shape, and atomicity checks;
- transcript review for direct HTTP/database/service bypass or hidden context inspection;
- expected answers, cross-store leakage detection, snapshots, and reports.

If Codex asks a reasonable clarification, that is a user-experience observation rather than an automatic failure. If it cannot discover Enterprise Hub, invents missing details, inspects implementation internals, or requires protocol jargon from the user, record that behavior honestly.

## Test changes

Add automated manifest checks that fail if any employee prompt contains forbidden controller/protocol language. Assert that the controller skill sends manifest turns verbatim and contains no reusable boundary prompt. Preserve fixture validity and contradictory-data tests.

Run the full deterministic profile in new visible tasks. If acknowledged real-provider configuration is available, repeat the independent retrieval subset. Preserve task transcripts, snapshots, logs, and a report that clearly distinguishes natural cold-start evidence from guided conformance evidence.

## Scope

This change modifies test fixtures, operator skill, documentation, and test scripts only. It does not change API, worker, domain, database schema, MCP tool behavior, or production authentication.
