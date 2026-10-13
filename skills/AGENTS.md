# Repository workflow Skills

- Keep `smedc-mcp` limited to MCP usage, login/install, tool parameters, status/error handling, upload transport, and structured-query semantics.
- Dataset-specific repair/conversion belongs in the service or a separate workflow Skill; the base Skill may upload originals and report service validation errors.

- Read `packages/mcp-contract/AGENTS.md` before changing MCP behavior/contracts/usage guidance; it owns companion-repository and release coordination.
- Keep employee-facing Skills on the launcher/MCP path; never introduce operator-only infrastructure, credentials or direct database access into employee guidance.
- Follow each Skill's `SKILL.md` for workflow details and validate affected references/examples against current tool schemas. Installation pins follow verified releases, not candidate README text.
