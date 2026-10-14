# MCP contracts and coordinated releases

Shared release-policy entrypoint for server MCP behavior, launcher runtime/contracts and Skill usage guidance.

- The SMEDC MCP skill is dual-homed in `skills/smedc-mcp/` and `YinXiaoyu-1998/smedc-mcp-skill`. Changes to MCP behavior, contracts, or usage guidance must update both and use an independent branch/PR in the standalone repository.
- Treat `apps/mcp-launcher/` and its bundled MCP contracts as one release boundary. Runtime or tool-contract changes must bump the launcher version and package/alignment tests in the same PR.
- Publish and independently verify the launcher before updating server recommended-version metadata and both Skill pins.

- Maintain strict Zod input schemas, limits, annotations and public error semantics alongside server and launcher consumers. Do not add arbitrary SQL/API-path escape hatches or client-controlled organization selectors.
- Reuse shared domain limits/registries instead of divergent copies; see `packages/domain/AGENTS.md`.
- Focused checks: `npm test -- packages/mcp-contract apps/mcp-launcher apps/api/src/mcp scripts/smedc-companion-skill.test.ts`; narrow when the change is internal.
