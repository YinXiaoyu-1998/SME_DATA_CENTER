import { defineConfig } from "tsup";

export const releaseEntries = {
  api: "apps/api/src/index.ts",
  worker: "apps/worker/src/dev-loop.ts",
  readiness: "scripts/readiness.ts",
  "staging-smoke": "scripts/staging-smoke.ts"
} as const;

const thirdPartyPackageImport = /^(?!@enterprise-hub(?:\/|$))[^./]/;

export default defineConfig({
  entry: releaseEntries,
  external: [thirdPartyPackageImport],
  format: ["esm"],
  outDir: "dist/release",
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: [/^@enterprise-hub\//]
});
