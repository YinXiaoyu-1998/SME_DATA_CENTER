import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

export const releaseEntries = {
  api: "apps/api/src/index.ts",
  worker: "apps/worker/src/dev-loop.ts",
  "ledger-pdf-render-check": "apps/worker/src/ledger-pdf/renderer.integration.ts",
  "ledger-pdf": "scripts/ledger-pdf.ts",
  "ledger-shelf-life": "scripts/ledger-shelf-life.ts",
  "shelf-life-catalog": "scripts/shelf-life-catalog.ts",
  readiness: "scripts/readiness.ts",
  "staging-smoke": "scripts/staging-smoke.ts",
  "official-manual-acceptance": "scripts/official-manual-acceptance.ts",
  "permissions-operator": "apps/api/src/permissions-operator/cli.ts",
  "auth-operator": "apps/api/src/auth/operator-cli.ts",
  "staging-upload-domain-cleanup": "scripts/staging-upload-domain-cleanup.ts",
  "partition-store-cleanup": "scripts/partition-store-cleanup.ts",
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
  metafile: true,
  splitting: false,
  noExternal: [/^@smedc\//, "exceljs/lib/doc/workbook.js", "readable-stream"],
  esbuildPlugins: [
    {
      name: "workbook-readable-stream",
      setup(build) {
        // JSZip still needs v2; the bundled workbook must resolve its own external v3.
        build.onResolve({ filter: /^readable-stream$/ }, (args) => ({
          path: /[\\/]node_modules[\\/]exceljs[\\/]/.test(args.importer)
            ? "readable-stream-v3"
            : args.path,
          external: true
        }));
      }
    }
  ],
  banner: {
    js: `/*! ExcelJS document workbook source\n${readFileSync("node_modules/exceljs/LICENSE", "utf8")}\n*/
import { createRequire as createReleaseRequire } from 'node:module'; const require = createReleaseRequire(import.meta.url);`
  }
});
