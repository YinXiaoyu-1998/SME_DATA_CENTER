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

Do not ask the user for an organization ID. Organization scope is derived by the service from the authenticated employee record, and no MCP tool should add an org header, query field, or body field.

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
4. When the user supplies an attached file or an explicit local file path, read the exact bytes of that assigned file and Base64-encode those bytes mechanically. Reading the assigned input file is allowed client-side input handling; do not inspect unrelated workspace files. Never retype, summarize, normalize, translate, or reconstruct file content from memory. If exact bytes cannot be read, ask the user to attach the file again instead of inventing a payload.
5. Evidence uploads use `upload_evidence_document` with `file: { name, mediaType, encoding: "base64", contentBase64 }`, `title`, and non-empty `labelKeys`. Never send a server-visible file path.
6. Structured uploads use `upload_structured_dataset` with the same inline file object plus `dataset`, `enterpriseName`, `startDate`, `endDate`, `idempotencyKey`, and `labelKeys`. For a network/client retry of the exact same file and metadata, reuse the same `idempotencyKey`; the service returns the originally persisted `documentId`, `importBatchId`, and storage key instead of duplicating data. Do not reuse an idempotency key for a different file, dataset, date window, enterprise, or label set.
7. Use `get_evidence_document_status` or `get_import_status` after uploads. Do not run a worker to accelerate processing. Poll gently and stop when status is final or when the user asks to stop.
8. Treat `get_import_status` not-found results as non-visible or missing. The service intentionally returns the same 404 shape for nonexistent, cross-org, disabled, or label-inaccessible import batches, so do not infer that a hidden batch exists or repeat hidden metadata.
9. Use `search_document_evidence`, `list_structured_datasets`, and `query_structured_dataset` only through the exposed tools. Do not send SQL or bypass backend authorization.
10. For evidence search pagination, pass the returned `page.nextCursor` back as `cursor` with the same query, filters, and limit to request the next page. Do not edit, decode, persist long term, or reuse cursors across employees, labels, queries, filters, limits, or service configurations.
11. If evidence search returns `INVALID_CURSOR`, restart the search without the cursor. If it returns `CURSOR_EXPIRED`, tell the user the cursor expired and restart only if the user still wants more results. If a document becomes inaccessible between pages, accept that it disappears.
12. `enterprise_hub_list_skills` returns approved Skill Directory metadata only; do not execute entries.
13. Call `enterprise_hub_logout_local` only when the user asks to clear the local login.

## Examples

English evidence pagination:

1. User asks: "Find the refund handling SOP and show more if there are additional matches."
2. Call `search_document_evidence` with the user's query, visible filters if needed, and a bounded `limit`.
3. If the response includes a non-null `page.nextCursor` and the user wants more, call the same tool again with the same query/filters/limit plus that cursor.
4. Summarize only returned visible evidence; never claim hidden documents exist.

中文结构化导入重试：

1. 用户说：“刚才上传菜品表网络断了，帮我确认有没有成功。”
2. 如果这是同一个文件和同一组 metadata，用原来的 `idempotencyKey` 重新调用 `upload_structured_dataset`。
3. 如果服务返回同一个 `documentId` / `importBatchId` / storage key，把它解释为精确重放成功，不是重复导入。
4. 如果 `get_import_status` 返回 404，只能说“当前登录身份不可见或该批次不存在”，不要猜测其它组织或隐藏批次。

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
| `INVALID_CURSOR`             | Restart the evidence search without the cursor; do not try to repair or decode it.                  |
| `CURSOR_EXPIRED`             | Explain that the page cursor expired and restart only if the user still wants more results.         |
| Idempotency conflict         | Explain that the retry key was reused for different upload content or metadata.                     |

Never expose raw JWTs, infer an enterprise from an email, claim inaccessible data exists, create reports or dashboard conclusions, or turn Enterprise Hub into a direct employee-facing agent.
