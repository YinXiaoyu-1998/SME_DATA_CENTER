import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { remoteScriptsForValidation } from "./deploy-staging.js";
import { type PdfReleaseBundle } from "./pdf-release.js";
const proof = (name: string): PdfReleaseBundle => ({
  api: { image: `registry/api:${name}`, id: `sha256:${"1".repeat(64)}`, pdfReader: true },
  worker: { image: `registry/worker:${name}`, id: `sha256:${"1".repeat(64)}`, pdfReader: true },
  releaseOps: {
    image: `registry/api:ops-${name}`,
    id: `sha256:${"1".repeat(64)}`,
    pdfReader: true
  },
  parser: null,
  pdfProcessing: false,
  uploads: false
});

describe("actual release rollback guards", () => {
  it.each([
    [false, "explicit"],
    [true, "explicit"],
    [false, "EXIT"],
    [true, "EXIT"]
  ] as const)(
    "checks all reader targets before touching Compose or jobs (compatible=%s, path=%s)",
    async (compatible, path) => {
      const root = await mkdtemp(join(tmpdir(), "smedc-pdf-rollback-"));
      const bin = join(root, "bin");
      try {
        await mkdir(bin);
        await mkdir(join(root, "pdf-runtime"));
        await writeFile(
          join(root, "pdf-runtime/state.json"),
          JSON.stringify({
            schemaVersion: 1,
            floorEstablished: true,
            current: proof("current"),
            rollback: proof("previous")
          })
        );
        await writeFile(
          join(root, "runtime.env"),
          "SMEDC_RELEASE_OPS_IMAGE=registry/api:ops-current\n"
        );
        await writeFile(
          join(root, "previous-release.env"),
          "SMEDC_API_IMAGE=registry/api:previous\nSMEDC_WORKER_IMAGE=registry/worker:previous\nSMEDC_RELEASE_OPS_IMAGE=registry/api:ops-previous\nSMEDC_PDF_PROCESSING_ENABLED=false\nSMEDC_PDF_UPLOAD_ENABLED=false\n"
        );
        await writeFile(join(root, "docker-compose.yml"), "current-compose\n");
        await writeFile(join(root, "previous-docker-compose.yml"), "previous-compose\n");
        const commands = {
          flock: "exit 0",
          curl: "exit 0",
          install:
            'args=(); while [ "$#" -gt 0 ]; do case "$1" in -o|-g|-m) shift 2;; *) args+=("$1"); shift;; esac; done; cp "${args[0]}" "${args[1]}"',
          docker: `
if [ "$1" = pull ]; then exit 0; fi
if [ "$1:$2" = image:inspect ]; then printf 'sha256:%s\\n' "$FAKE_IMAGE_ID"; exit 0; fi
if [ "$1" = run ]; then
  args=("$@")
  for ((i=0;i<\${#args[@]};i++)); do
    if [ "\${args[$i]}" = dist/release/pdf-release.js ]; then
      tool_args=("\${args[@]:$((i+1))}")
        tool_args[1]="$FAKE_STATE_DIR\${tool_args[1]#/state}"
      if [ "\${tool_args[0]}" = park ]; then printf 'park\\n' >> "$FAKE_MUTATIONS"; exit 0; fi
      exec "$FAKE_NODE" --import tsx "$FAKE_TOOL" "\${tool_args[@]}"
    fi
  done
  printf '%s' "$FAKE_COMPATIBLE"; exit 0
fi
if [[ "$*" = *config\\ --services* ]]; then printf 'pdf-worker\\npdf-parser\\n'; exit 0; fi
printf 'compose\\n' >> "$FAKE_MUTATIONS"
`
        };
        for (const [name, body] of Object.entries(commands)) {
          await writeFile(join(bin, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
          await chmod(join(bin, name), 0o755);
        }
        const result = spawnSync("bash", ["-s"], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env["PATH"]}`,
            FAKE_NODE: process.execPath,
            FAKE_TOOL: join(process.cwd(), "scripts/pdf-release.ts"),
            FAKE_IMAGE_ID: "1".repeat(64),
            FAKE_STATE_DIR: join(root, "pdf-runtime"),
            FAKE_COMPATIBLE: String(compatible),
            FAKE_MUTATIONS: join(root, "mutations")
          },
          input: (() => {
            const scripts = remoteScriptsForValidation();
            const rollback = scripts[1]!;
            if (path === "explicit") return rollback.replaceAll("/opt/smedc", root);
            const rollout = scripts[0]!;
            const handler = rollout.slice(
              rollout.indexOf("rollback_on_error() {"),
              rollout.indexOf("trap rollback_on_error EXIT")
            );
            return `${rollback.slice(0, rollback.indexOf("pdf_restore_previous\n"))}\nrollback_armed=1\n${handler}\ntrap rollback_on_error EXIT\nexit 42\n`.replaceAll(
              "/opt/smedc",
              root
            );
          })()
        });
        if (path === "explicit") expect(result.status === 0, result.stderr).toBe(compatible);
        else expect(result.status, result.stderr).toBe(42);
        expect(await readFile(join(root, "docker-compose.yml"), "utf8")).toBe(
          compatible ? "previous-compose\n" : "current-compose\n"
        );
        if (compatible) {
          expect(await readFile(join(root, "mutations"), "utf8")).toContain("park");
          expect(
            JSON.parse(await readFile(join(root, "pdf-runtime/state.json"), "utf8"))
              .floorEstablished
          ).toBe(true);
        } else
          await expect(readFile(join(root, "mutations"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    10_000
  );
});
