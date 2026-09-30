import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  readPdfManifest,
  writePdfManifest,
  dispatchAcceptanceProfile
} from "./pdf-acceptance-controller.js";
import { createPdfAcceptanceManifest } from "./pdf-acceptance-support.js";

describe("PDF controller boundary", () => {
  it("routes PDF before any legacy action and never falls through on failure", async () => {
    const legacy = vi.fn();
    const pdf = vi.fn().mockRejectedValue(new Error("missing profile"));
    await expect(
      dispatchAcceptanceProfile(
        ["cleanup", "--profile=pdf", "--run-id=test7", "--manifest=/private/test.json"],
        { legacy, pdf }
      )
    ).rejects.toThrow("missing profile");
    expect(legacy).not.toHaveBeenCalled();
    await expect(dispatchAcceptanceProfile(["--profile=other"], { legacy, pdf })).rejects.toThrow();
    expect(legacy).not.toHaveBeenCalled();
    await dispatchAcceptanceProfile([], { legacy, pdf });
    expect(legacy).toHaveBeenCalledOnce();
  });
  it("persists only safe validated manifests atomically with private permissions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pdf-manifest-"));
    const target = path.join(dir, "manifest.json");
    try {
      await writePdfManifest(target, createPdfAcceptanceManifest("test7"));
      expect((await stat(target)).mode & 0o777).toBe(0o600);
      expect(await readPdfManifest(target, "test7")).toMatchObject({ runId: "test7" });
      await expect(readPdfManifest(target, "other")).rejects.toThrow();
      expect(await readFile(target, "utf8")).not.toMatch(/password|token|setupUrl/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
