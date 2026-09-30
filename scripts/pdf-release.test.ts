import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  transitionPdfRuntimeState,
  verifyPdfRuntimeState,
  type PdfReleaseBundle
} from "./pdf-release.js";

const bundle = (name: string, compatible = true): PdfReleaseBundle => ({
  api: { image: `registry/api:${name}`, id: `sha256:${"a".repeat(64)}`, pdfReader: compatible },
  worker: {
    image: `registry/worker:${name}`,
    id: `sha256:${"b".repeat(64)}`,
    pdfReader: compatible
  },
  releaseOps: {
    image: `registry/api:ops-${name}`,
    id: `sha256:${"c".repeat(64)}`,
    pdfReader: compatible
  },
  parser: {
    image: `registry/api:pdf-${name}`,
    id: `sha256:${"d".repeat(64)}`,
    parserFingerprint: "e".repeat(64),
    schemaVersion: 1
  },
  pdfProcessing: false,
  uploads: false
});

describe("durable PDF rollback floor", () => {
  it("requires a disabled compatibility deployment before first enable", () => {
    const legacy = bundle("legacy", false);
    const current = bundle("first");
    const disabled = transitionPdfRuntimeState(null, current, legacy);
    expect(disabled.floorEstablished).toBe(false);
    expect(() =>
      transitionPdfRuntimeState(
        disabled,
        { ...current, uploads: true, pdfProcessing: true },
        legacy
      )
    ).toThrow(/compatible/);
    const enabled = transitionPdfRuntimeState(
      disabled,
      { ...bundle("second"), uploads: true, pdfProcessing: true },
      current
    );
    expect(enabled.floorEstablished).toBe(true);
    expect(transitionPdfRuntimeState(enabled, current, current).floorEstablished).toBe(true);
    expect(() => transitionPdfRuntimeState(enabled, legacy, current)).toThrow(/compatible/);
    expect(() =>
      transitionPdfRuntimeState(enabled, current, { ...current, worker: legacy.worker })
    ).toThrow(/compatible/);
  });
  it("refuses to guess when a compatible runtime loses its floor state", () => {
    expect(() => transitionPdfRuntimeState(null, bundle("next"), bundle("existing"))).toThrow(
      /missing/
    );
  });
  it("verifies every reader identity and rejects missing or unestablished proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "smedc-pdf-state-"));
    const path = join(root, "state.json");
    try {
      const current = { ...bundle("next"), uploads: true, pdfProcessing: true };
      const state = transitionPdfRuntimeState(
        {
          schemaVersion: 1,
          floorEstablished: false,
          current: bundle("old"),
          rollback: bundle("legacy", false)
        },
        current,
        bundle("old")
      );
      await writeFile(path, JSON.stringify(state));
      expect(
        verifyPdfRuntimeState(JSON.parse(await readFile(path, "utf8")), {
          SMEDC_API_IMAGE: current.api.image,
          SMEDC_WORKER_IMAGE: current.worker.image,
          SMEDC_RELEASE_OPS_IMAGE: current.releaseOps.image,
          SMEDC_PDF_PARSER_IMAGE: current.parser!.image
        })
      ).toBe(true);
      expect(verifyPdfRuntimeState(state, { SMEDC_API_IMAGE: "registry/api:other" })).toBe(false);
      expect(verifyPdfRuntimeState({ ...state, floorEstablished: false }, {})).toBe(false);
      expect(verifyPdfRuntimeState({ ...state, rollback: bundle("legacy", false) }, {})).toBe(
        false
      );
      expect(verifyPdfRuntimeState(null, {})).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
