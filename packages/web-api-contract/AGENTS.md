# Web API 契约

浏览器网页接口的唯一事实来源。前端仓按 commit 拉取本包产出的 `contract.json` 生成 zod，因此这里的改动等同于对外接口变更。

## 规则

- 新增或修改浏览器接口，必须先改 `src/registry.ts` 的路由表，再改 handler；不得先写 handler 再补登记。
- 每条路由必须声明 `response`（zod）与 `errors`。带 `params`/`query`/`body` 的路由必须声明 `WEB_API_INVALID_REQUEST`；所有路由都必须声明 `BROWSER_SIGN_IN_REQUIRED`。
- `auth: "browser-write"` 只能用于非 GET，表示该路由还要求同源 Origin 与 CSRF 校验。
- 改完运行 `npm run contract:emit` 并提交 `contract.json`；`npm test -- packages/web-api-contract` 会校验它与路由表一致。
- `contract.json` 不含时间戳与提交号，因此重新生成必须字节一致。前端通过 `--ref <sha>` 记录后端版本。
- 路由只描述浏览器面（`/api/web/v1`）。`/v1`、`/mcp` 属于 MCP 契约，见 `packages/mcp-contract`。
