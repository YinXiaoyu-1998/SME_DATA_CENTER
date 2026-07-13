# Enterprise Hub MCP User Flow

Last updated: 2026-07-13

This document describes the current Phase 3 design from a user's natural-language
request to Enterprise Hub MCP tool execution. It is intentionally about request
flow and trust boundaries, not service operations. The same flow applies when
the Enterprise Hub service runs locally or remotely; only the configured base URL
changes.

Related documents:

- [Local MCP endpoint decisions](./mcp-endpoint.md)
- [Local agent test prompts](./local-agent-test.md)
- [API and MCP contract](./api-contract.md)

## Actors And Links

```mermaid
flowchart LR
  User["User"]
  Agent["Agent and MCP client<br/>Codex, Claude, OpenClaw, etc."]
  Skill["enterprise-hub-mcp skill<br/>instructions only"]
  Launcher["MCP launcher<br/>apps/mcp-launcher"]
  ApiMcp["Enterprise Hub API<br/>POST /mcp"]
  Auth["Auth issuer<br/>current: /auth/dev-login<br/>future: SSO/OIDC"]
  ApiRoutes["Existing authenticated API behavior"]
  Db["MySQL<br/>employees, labels, documents, audits, imports"]
  Storage["Object storage<br/>original uploaded files"]
  Worker["Worker<br/>async processing and indexing"]
  Qdrant["Qdrant<br/>evidence vectors"]

  User -->|"natural language"| Agent
  Agent -->|"reads local instructions"| Skill
  Agent <-->|"MCP stdio"| Launcher
  Launcher <-->|"Streamable HTTP POST /mcp<br/>Authorization: Bearer token"| ApiMcp
  Launcher -->|"login bootstrap request"| Auth
  ApiMcp -->|"request-scoped delegation"| ApiRoutes
  Auth -->|"employee lookup / token claims"| Db
  ApiRoutes -->|"authorization, catalog, audit, import state"| Db
  ApiRoutes -->|"write/read original bytes"| Storage
  Worker -->|"claim processing work"| Db
  Worker -->|"read original bytes"| Storage
  Worker -->|"write/read evidence index"| Qdrant
  Worker -->|"publish processing status"| Db
```

Protocol summary:

| Hop                                 | Protocol / channel                   | Carries credentials?                                      | Notes                                                                   |
| ----------------------------------- | ------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| User -> Agent                       | Natural language                     | No raw token                                              | The user asks for an Enterprise Hub action, such as uploading a file.   |
| Agent -> Skill                      | Local skill instructions             | No                                                        | The skill tells the agent how to configure and use the launcher.        |
| MCP client -> Launcher              | Local MCP stdio                      | No raw token in configuration                             | The client starts the launcher from MCP config when needed.             |
| Launcher -> Auth issuer             | HTTP                                 | Development login email today; future SSO/OIDC may differ | The launcher keeps the issued token only in process memory.             |
| Launcher -> `POST /mcp`             | Streamable HTTP                      | `Authorization: Bearer <token>`                           | Added by the launcher to every initialize, discovery, and tool request. |
| API `/mcp` -> Existing API behavior | In-process request-scoped delegation | Auth context only                                         | Business authorization remains in the backend API behavior.             |
| Worker -> DB/storage/Qdrant         | Internal service calls               | Service credentials, not agent credentials                | Asynchronous processing is outside the skill/launcher lifecycle.        |

## Cold Start To Upload Request

The user's first prompt may be:

```text
Use Enterprise Hub MCP to upload my xx file.
```

The flow below includes the case where the MCP launcher is not yet configured
and the case where it is already configured but not currently running.

```mermaid
flowchart TD
  A["User cold-starts agent<br/>Enterprise Hub service already exists at a URL"] --> B["User asks:<br/>upload xx file to Enterprise Hub"]
  B --> C{"Does the agent have<br/>enterprise-hub MCP config?"}
  C -->|"No"| D["Skill asks for missing setup values:<br/>Enterprise Hub base URL<br/>registered employee identity"]
  D --> E["Agent writes client-native MCP config<br/>command: npm run --silent mcp:launcher<br/>env: ENTERPRISE_HUB_BASE_URL only"]
  E --> F["User restarts or refreshes MCP client<br/>if required by that client"]
  C -->|"Yes"| G["MCP client starts or reuses launcher process"]
  F --> G
  G --> H{"Launcher has a current<br/>model-invisible employee token?"}
  H -->|"Yes"| I["Launcher calls remote MCP tools<br/>with Authorization header"]
  H -->|"No"| J["Business tool returns EMPLOYEE_AUTH_REQUIRED<br/>or launcher reports no local login"]
  J --> K["Agent asks for employee identity<br/>current dev: registered email<br/>future: service-approved login/SSO step"]
  K --> L["Agent calls enterprise_hub_login_local<br/>or future local login bootstrap"]
  L --> M{"Login succeeds?"}
  M -->|"No: service unreachable"| N["Agent reports URL is unreachable<br/>does not start or repair service"]
  M -->|"No: identity rejected"| O["Agent asks user to verify identity<br/>does not seed or modify service data"]
  M -->|"Yes"| P["Launcher stores token in process memory only<br/>token is not returned to agent"]
  P --> I
  I --> Q["Agent reads the selected local file bytes<br/>from the user's machine"]
  Q --> R["Agent supplies inline Base64 MCP file object<br/>name, mediaType, encoding, contentBase64"]
  R --> S["Upload tool executes through Enterprise Hub"]
  S --> T["Agent reports service upload result<br/>document/import id and status only"]
```

Current Phase 3 nuance: because the launcher stores the development JWT only in
process memory, a fully cold launcher start is normally not logged in yet. The
"already logged in" branch represents an already-running launcher process today,
or a future model-invisible SSO/OIDC token source after Phase 4 authentication
work exists.

## Authenticated Upload Sequence

This sequence starts after the launcher has an employee token. The employee
token can come from today's development email login or from a future SSO/OIDC
flow; the `/mcp` service contract remains bearer authentication per request.

```mermaid
sequenceDiagram
  autonumber
  participant U as "User"
  participant A as "Agent / MCP client"
  participant L as "MCP launcher"
  participant M as "API POST /mcp"
  participant B as "Existing upload API behavior"
  participant D as "MySQL"
  participant S as "Object storage"
  participant W as "Worker"
  participant Q as "Qdrant"

  U->>A: "Upload this file to Enterprise Hub"
  A->>L: "MCP tool call over stdio: upload_evidence_document or upload_structured_dataset"
  L->>M: "Streamable HTTP POST /mcp with Authorization: Bearer token"
  M->>M: "Validate loopback, method, JSON, body size, request id, bearer token"
  M->>B: "Delegate request with authenticated employee context"
  B->>D: "Load employee, labels, permissions, idempotency state"
  B->>B: "Validate label access, inline file shape, metadata, decoded size"
  B->>S: "Write original uploaded bytes"
  B->>D: "Create document/import records, labels, audit event, processing status"
  B-->>M: "Business result or stable service error"
  M-->>L: "MCP response"
  L-->>A: "MCP response without token"
  A-->>U: "Report id, accepted status, and next status-check step"

  W->>D: "Later: claim queued processing/import work"
  W->>S: "Read original bytes when needed"
  W->>Q: "Write evidence vectors for evidence documents"
  W->>D: "Publish active/index-ready or validation failure status"
```

Important boundaries:

- The agent may read the user's selected local file and encode it into the MCP
  tool input.
- The service never dereferences a client `filePath`; it receives explicit inline
  bytes through the MCP contract.
- `/mcp` authenticates every request, including initialization and tool discovery.
- Backend authorization remains authoritative for labels, uploads, queries,
  search visibility, and hidden-resource behavior.
- The skill and launcher do not start the API, worker, database, storage, or
  Qdrant. If the service URL is unreachable, the agent reports that failure.

## Not Logged In Sequence

```mermaid
sequenceDiagram
  autonumber
  participant U as "User"
  participant A as "Agent / MCP client"
  participant L as "MCP launcher"
  participant Auth as "Auth issuer"
  participant D as "MySQL / identity store"
  participant M as "API POST /mcp"

  U->>A: "Upload/search with Enterprise Hub"
  A->>L: "MCP initialize or business tool call over stdio"
  L->>M: "POST /mcp without usable bearer token"
  M-->>L: "EMPLOYEE_AUTH_REQUIRED"
  L-->>A: "Safe login-required result"
  A-->>U: "Ask for registered employee identity or service-approved login step"
  U-->>A: "Provides email today, or completes future SSO/OIDC step"
  A->>L: "enterprise_hub_login_local(email) today"
  L->>Auth: "HTTP login bootstrap"
  Auth->>D: "Verify employee exists and is enabled"
  Auth-->>L: "Employee token and safe employee summary"
  L->>L: "Store token only in process memory"
  L-->>A: "Return safe login status, email, service URL; never token"
  A->>L: "Retry intended MCP business tool"
  L->>M: "POST /mcp with Authorization: Bearer token"
  M-->>L: "Authenticated MCP response"
```

Failure mapping:

| Failure                                  | Visible result                                                      | Agent behavior                                                    |
| ---------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Missing URL                              | Ask for Enterprise Hub base URL                                     | Do not invent a URL.                                              |
| Service unreachable                      | `ENTERPRISE_HUB_UNREACHABLE`                                        | Report connection failure; do not start or repair services.       |
| Missing/expired/restarted launcher token | `EMPLOYEE_AUTH_REQUIRED`                                            | Ask the user to authenticate again.                               |
| Unknown or disabled employee             | Safe authentication failure                                         | Ask the user to verify identity; do not seed or modify employees. |
| Forbidden label/resource                 | Forbidden, not found, or empty result according to backend contract | Do not infer hidden resources exist.                              |

## Search After Upload

Evidence search is a separate authenticated tool call. Upload acceptance does
not guarantee the evidence index is ready.

```mermaid
flowchart TD
  A["Upload accepted"] --> B["Agent calls get_evidence_document_status"]
  B --> C{"Document active and<br/>evidence index ready?"}
  C -->|"No"| D["Agent reports exact service status<br/>or waits/polls if user requested"]
  C -->|"Yes"| E["Agent calls search_document_evidence"]
  E --> F["Launcher sends POST /mcp<br/>with bearer auth"]
  F --> G["API authorizes employee labels<br/>and queries visible evidence only"]
  G --> H["MySQL filters visible document ids"]
  H --> I["Qdrant returns matching visible chunks"]
  I --> J["Agent returns evidence chunks/status<br/>not a generated business report"]
```

Structured query after import follows the same launcher and `/mcp`
authentication path, but uses MySQL controlled query behavior instead of Qdrant
evidence retrieval.
