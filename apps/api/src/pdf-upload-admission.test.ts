import { describe, expect, it, vi } from "vitest";
import { checkParserReadiness, createPdfUploadAdmission } from "./pdf-upload-admission.js";

const environment = {
  SMEDC_PDF_UPLOAD_ENABLED: "true",
  SMEDC_PDF_SERVICE_URL: "http://parser.synthetic.test",
  SMEDC_PDF_SERVICE_TOKEN: "s".repeat(32)
};
const ready = () =>
  Response.json({ status: "ready", schemaVersion: 1, parserFingerprint: "a".repeat(64) });

describe("PDF upload admission", () => {
  it("fails closed without an actual rollback verifier even when a caller supplies a VERIFIED flag", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => ready());
    const admission = createPdfUploadAdmission({
      environment: { ...environment, SMEDC_PDF_COMPATIBLE_ROLLBACK_VERIFIED: "true" },
      fetch
    });
    expect(await admission()).toEqual({ allowed: false, code: "PDF_ROLLBACK_FLOOR_UNVERIFIED" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("checks rollback verification every time and caches only a bounded readiness result", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => ready());
    let verified = true;
    let now = 0;
    const admission = createPdfUploadAdmission({
      environment,
      verifyRollbackFloor: async () => verified,
      fetch,
      now: () => now
    });
    expect(await admission()).toEqual({ allowed: true });
    expect(await admission()).toEqual({ allowed: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    verified = false;
    expect(await admission()).toEqual({ allowed: false, code: "PDF_ROLLBACK_FLOOR_UNVERIFIED" });
    verified = true;
    now = 5001;
    expect(await admission()).toEqual({ allowed: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    () => Response.json({ status: "ready", schemaVersion: 1, parserFingerprint: "bad" }),
    () => new Response("x".repeat(1025)),
    () => new Response("no", { status: 401 }),
    () => new Response(null, { status: 302, headers: { location: "https://external.invalid" } })
  ])(
    "denies unsafe/unready parser replies without returning internal payloads",
    async (response) => {
      const admission = createPdfUploadAdmission({
        environment,
        verifyRollbackFloor: async () => true,
        fetch: async () => response()
      });
      expect(await admission()).toEqual({ allowed: false, code: "PDF_SERVICE_UNAVAILABLE" });
    }
  );
  it("aborts a hung readiness request at the finite admission deadline", async () => {
    const fetch: typeof globalThis.fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new Error("private failure")), {
          once: true
        });
      });
    const admission = createPdfUploadAdmission({
      environment,
      verifyRollbackFloor: async () => true,
      fetch,
      timeoutMs: 10
    });
    expect(await admission()).toEqual({ allowed: false, code: "PDF_SERVICE_UNAVAILABLE" });
  });
});

// A reachable stale parser must not satisfy the deployment's verified image proof.
it("checks the verified parser fingerprint during release readiness", async () => {
  expect(
    await checkParserReadiness({
      environment,
      expectedFingerprint: "b".repeat(64),
      fetch: async () => ready()
    })
  ).toBe(false);
  expect(
    await checkParserReadiness({
      environment,
      expectedFingerprint: "a".repeat(64),
      fetch: async () => ready()
    })
  ).toBe(true);
});
