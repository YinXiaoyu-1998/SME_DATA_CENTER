import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: {
    resolve: ["@enterprise-hub/mcp-contract", "@enterprise-hub/domain"]
  },
  clean: true,
  noExternal: ["@enterprise-hub/mcp-contract", "@enterprise-hub/domain"],
  external: ["@modelcontextprotocol/sdk", "@napi-rs/keyring", "oauth4webapi", "open", "zod"]
});
