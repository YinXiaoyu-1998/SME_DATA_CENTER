import { defineConfig } from "tsup";

export const releaseEntries = {
  api: "apps/api/src/index.ts",
  worker: "apps/worker/src/dev-loop.ts",
  "ledger-pdf-render-check": "apps/worker/src/ledger-pdf/renderer.integration.ts",
  readiness: "scripts/readiness.ts",
  "staging-smoke": "scripts/staging-smoke.ts",
  "official-manual-acceptance": "scripts/official-manual-acceptance.ts",
  "auth-operator": "apps/api/src/auth/operator-cli.ts",
  "staging-upload-domain-cleanup": "scripts/staging-upload-domain-cleanup.ts",
  "evidence-reindex": "scripts/reindex-evidence.ts"
} as const;

const thirdPartyPackageImport = /^(?!@smedc(?:\/|$))[^./]/;

export default defineConfig({
  entry: releaseEntries,
  external: [thirdPartyPackageImport],
  format: ["esm"],
  outDir: "dist/release",
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: [/^@smedc\//]
});
