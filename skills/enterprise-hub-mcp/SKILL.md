---
name: enterprise-hub-mcp
description: Use when connecting Codex or another MCP client to Enterprise Hub, configuring the local launcher, logging in to a development employee identity, or uploading/searching approved Enterprise Hub data.
---

# Enterprise Hub MCP

## Boundary

Enterprise Hub is a retrieval and data foundation. This skill configures and uses its MCP launcher; it is not allowed to operate the Enterprise Hub service.

Do not start, stop, seed, migrate, initialize, repair, or inspect the API, worker, Docker, database, Qdrant, storage, or background jobs. If the configured service is unreachable, report the connection failure. Do not fall back to curl, direct API calls, database access, storage access, or service-management commands.

The service exposes only authenticated stateless Streamable HTTP at `POST <Enterprise Hub URL>/mcp`. The launcher may use stdio only between the local MCP client and itself. The service has no stdio MCP adapter.

## Configuration

When Enterprise Hub tools are requested but no launcher is configured, ask for:

1. The Enterprise Hub base URL.
2. The employee email registered in that service.

For this Phase 3 local-development implementation, configure Codex to start the launcher, without adding a token:

```toml
[mcp_servers.enterprise-hub]
command = "npm"
args = ["run", "--silent", "mcp:launcher"]
cwd = "/path/to/SME_DATA_CENTER"
startup_timeout_sec = 120

[mcp_servers.enterprise-hub.env]
ENTERPRISE_HUB_BASE_URL = "http://127.0.0.1:3000"
```

For another MCP client, use the equivalent command/cwd/environment configuration. `ENTERPRISE_HUB_BASE_URL` is the only launcher configuration value. Never put a bearer token, password, session file, service account key, or credential in MCP configuration, environment, arguments, or skill content.

The URL may point to a locally running service in this phase. Do not try to make it run. Production SSO/OIDC, TLS, and remote deployment remain future scope.

## Login And Use

1. Call `enterprise_hub_login_local` with the supplied registered employee email. This currently calls the service's development login endpoint.
2. The launcher retains the JWT only in its own process memory. It returns only safe employee identity and service URL. A launcher restart requires a new login.
3. Call `enterprise_hub_list_labels` before upload and use returned label keys only.
4. Evidence uploads use `upload_evidence_document` with `file: { name, mediaType, encoding: "base64", contentBase64 }`, `title`, and non-empty `labelKeys`. Never send a server-visible file path.
5. Structured uploads use `upload_structured_dataset` with the same inline file object plus `dataset`, `enterpriseName`, `startDate`, `endDate`, `idempotencyKey`, and `labelKeys`.
6. Use `get_evidence_document_status` or `get_import_status` after uploads. Do not run a worker to accelerate processing.
7. Use `search_document_evidence`, `list_structured_datasets`, and `query_structured_dataset` only through the exposed tools. Do not send SQL or bypass backend authorization.
8. `enterprise_hub_list_skills` returns approved Skill Directory metadata only; do not execute entries.
9. Call `enterprise_hub_logout_local` only when the user asks to clear the local login.

## Tools

Launcher-local bootstrap tools:

- `enterprise_hub_login_local`
- `enterprise_hub_logout_local`

Service business tools:

- `enterprise_hub_list_labels`
- `enterprise_hub_list_skills`
- `upload_evidence_document`
- `get_evidence_document_status`
- `search_document_evidence`
- `upload_structured_dataset`
- `get_import_status`
- `list_structured_datasets`
- `query_structured_dataset`

## Safe Failures

| Condition                    | Response                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| No URL or employee email     | Ask only for the missing value.                                                                     |
| `EMPLOYEE_AUTH_REQUIRED`     | Ask the user to verify the registered email and run local login again.                              |
| `ENTERPRISE_HUB_UNREACHABLE` | Report that the URL cannot be reached; do not start or repair services.                             |
| Permission/not-found result  | Treat it as non-visible; do not infer hidden resources.                                             |
| Upload validation error      | Return the service validation result; do not rewrite or inspect the file through service internals. |

Never expose raw JWTs, infer an enterprise from an email, claim inaccessible data exists, create reports or dashboard conclusions, or turn Enterprise Hub into a direct employee-facing agent.
