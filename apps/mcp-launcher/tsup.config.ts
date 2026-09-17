import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: {
    resolve: ["@smedc/mcp-contract", "@smedc/domain"]
  },
  clean: true,
  noExternal: ["@smedc/mcp-contract", "@smedc/domain"],
  external: ["@modelcontextprotocol/sdk", "@napi-rs/keyring", "oauth4webapi", "open", "zod"]
});
