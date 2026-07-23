# First Beta User Readiness

Last verified: 2026-07-23

## Goal

让一名真实 beta 用户从自己的 MCP client 调用
`https://api.smedatacenter.xyz`，完成登录、列出授权标签、上传、异步索引、检索和退出，
同时保持 backend authorization、secret redaction 和可撤销性。

“真实 beta 用户”与“真实客户数据”是两个不同门槛。前者应该先用 fixture 或明确批准的
非敏感资料上线；后者要等恢复和数据治理门槛闭环。

## Verified Current Facts

| Boundary          | Current evidence                                                                                       | Result                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Public liveness   | `GET /healthz`                                                                                         | `200`                                                |
| Private readiness | public `GET /readyz`                                                                                   | `404`, as designed                                   |
| Production login  | public `POST /auth/dev-login`                                                                          | `404`; no usable beta login exists                   |
| Public MCP        | public `POST /mcp`                                                                                     | `403 MCP_LOOPBACK_REQUIRED`                          |
| Ordinary API auth | unauthenticated `/me`, `/labels`, `/skills`, and structured datasets                                   | `401`                                                |
| Launcher          | code accepts only base URL and logs in through development email login                                 | cannot authenticate to staging                       |
| Identity data     | staging seed contains only synthetic employees and labels                                              | no real beta employee exists                         |
| Token schema      | Prisma `access_tokens` has hash/expiry/revocation/last-use fields                                      | schema exists; runtime support is not implemented    |
| Delivery          | trusted `main` quality success deploys the same immutable SHA                                          | verified at `708128503656`                           |
| Runtime           | API/worker/Qdrant healthy; root-only runtime env is `0600`                                             | verified                                             |
| Capacity snapshot | API about 260 MiB, worker 193 MiB, Qdrant 43 MiB; disk 27% used                                        | sufficient for one controlled beta, not a load claim |
| Recent logs       | no `error`/`fatal`/`panic`/`unhandled` matches in app container logs over the inspected 24 hours       | manual snapshot only; no alerting                    |
| RDS backup        | 7-day full-backup retention, log backup enabled for 7 days, one successful system full backup observed | backup exists; restore has not been rehearsed        |
| RDS transport     | provider SSL is disabled; app currently uses private VPC TCP                                           | current fact verified; final policy is open          |
| RDS lifecycle     | prepaid instance expires 2026-08-21; auto-renew duration is `0`; deletion protection is off            | human cost/protection decision required              |
| OSS runtime       | live runtime uses bucket `yxy-test-sme-data-center`, prefix `enterprise-hub`                           | readiness and fixture lifecycle passed               |

RDS Copilot Professional Edition is not activated for this Alibaba Cloud account. Its conversational
diagnostic API therefore returned `InvalidOrder`. This is not a beta blocker because the underlying
RDS facts above were read directly through the normal authenticated RDS CLI.

## Hard Blockers For A Real Beta User

1. There is no production-safe way for the user to obtain a credential.
2. The public reverse-proxied MCP route is deliberately rejected by the Phase 3 loopback guard.
3. There is no real beta employee, role, or label assignment.
4. The launcher has no secure production credential bootstrap.

These must be solved together. Changing nginx alone or handing out the staging JWT secret would be
unsafe and would not produce a supportable beta flow.

## Recommended Next Slice

Implement ADR 0021 as one beta-access slice:

1. add operator-only employee and token issue/list/revoke commands;
2. validate opaque access tokens in the shared API authentication layer;
3. add an interactive local credential helper and launcher secure-store loading;
4. open `/mcp` only through the loopback nginx TLS boundary while retaining local-development guards;
5. update both Enterprise Hub MCP skill homes and publish a client-specific onboarding recipe;
6. run external-machine acceptance for valid, expired, revoked, disabled, and cross-label identities;
7. onboard exactly one non-admin beta user and complete fixture upload/index/search.

This is the shortest safe path to a real remote user. Full OIDC/SSO, admin UI, and broad employee
directory import remain later work.

## Human Inputs Still Required

| Input                             | Why it is needed                                                           | Recommended default                                                   |
| --------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Beta email and display name       | creates the permission subject                                             | real beta identity                                                    |
| Role and allowed label keys       | defines backend visibility                                                 | `employee`, one personal label, only explicitly approved store labels |
| MCP client and operating system   | determines the credential-store helper and exact install recipe            | Codex Desktop on macOS if that is the beta setup                      |
| First-run data class              | distinguishes real user testing from real customer-data approval           | repo fixture or non-sensitive internal test document                  |
| Beta token lifetime               | bounds the temporary credential                                            | 30 days                                                               |
| Operations alert recipient        | required for minimal outage/disk/expiry alerting                           | confirm whether `consyinxy@gmail.com` may be reused                   |
| RDS renewal/protection decision   | instance expires 2026-08-21 and cost-impacting changes need human approval | enable auto-renew and deletion protection before real-data beta       |
| Recovery target and owner         | determines when a restore drill is acceptable                              | proposed RPO 24h, RTO 4h, owner: repository operator                  |
| Real-data retention/deletion rule | required before importing customer documents                               | defer real customer data until explicitly approved                    |

No additional ACR, SSH, RDS password, JWT secret, OSS key, domain, TLS, or GitHub Actions secret is
currently needed from the human.

## Provided And Verified

- Alibaba Cloud OAuth CLI, SWAS, VPC/RDS connectivity, RDS app account and database.
- Beijing ACR namespace/repositories and registry credential delivery.
- Simple Application Server, Docker/Compose/nginx, DNS, TLS, cert renewal.
- GitHub `staging` environment variables/secrets and trusted-main automated deployment.
- OSS and real embedding/rerank providers for fixture-only smoke.
- Synthetic migration/seed/Qdrant initialization and end-to-end fixture smoke.

## Provided Or Existing But Not Fully Validated

- RDS backup creation is verified, but no restore drill or recovery-time measurement exists.
- Automatic deployment rollback logic exists, but no intentional live rollback drill has been run.
- RDS private connectivity works, but provider SSL remains disabled.
- Docker logs are bounded and manually inspectable, but no proactive alert reaches an operator.
- Server capacity is adequate in one idle snapshot; no one-user concurrency or upload-size soak has
  been run against the public beta path.
- The `access_tokens` table exists, but no runtime code exercises issue/revoke/authenticate behavior.

## Design Still Open

- Long-term OIDC/SSO provider, MFA and employee lifecycle synchronization.
- Production admin identity and admin operations UI.
- Token audience/rotation policy after the beta bridge.
- Alerting channel, severity, support hours and incident owner.
- RPO/RTO, restore owner and whether a restore drill may create a temporary billable RDS instance.
- Real customer-data classification, retention, deletion, subject access and staging policy.
- OSS versioning/lifecycle protection for authoritative originals.
- Capacity target and scaling trigger beyond the first controlled user.

## Beta Acceptance Gates

### Real user, fixture/non-sensitive data

- beta employee exists with reviewed role and labels;
- credential is installed without appearing in chat, MCP config, process arguments or logs;
- public MCP initialize/discovery/tool calls succeed over HTTPS;
- expired/revoked token and disabled employee fail closed;
- a second employee cannot discover beta-only records;
- fixture upload, worker indexing and evidence search complete;
- audit records identify the employee and operation;
- logout/credential removal and operator revoke are tested.

### Before real customer data

- restore objective is approved and one restore/recovery procedure is rehearsed;
- original-file retention/deletion policy is recorded and executable;
- minimal uptime, disk, worker-failure and RDS-expiry alerts reach a confirmed recipient;
- controlled application rollback is rehearsed;
- the exact first dataset and its label scope are approved.
