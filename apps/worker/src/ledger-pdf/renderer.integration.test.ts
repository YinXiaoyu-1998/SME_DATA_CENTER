import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { verifySyntheticLedgerRender } from "./renderer.integration.js";

it.skipIf(process.env.LEDGER_PDF_RENDER_INTEGRATION !== "1")(
  "converts a multi-page Chinese ledger and two labelled images in the controlled runtime",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "smedc-real-pdf-test-"));
    try {
      const result = await verifySyntheticLedgerRender(directory);
      expect(result.pageCount).toBeGreaterThan(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  240_000
);
