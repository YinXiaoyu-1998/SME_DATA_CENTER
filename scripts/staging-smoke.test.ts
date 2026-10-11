import { afterEach, expect, it, vi } from "vitest";
import { uploadFixture } from "./staging-smoke.js";

afterEach(() => vi.unstubAllGlobals());

it("sends explicit business attributes on the actual staging fixture upload", async () => {
  let form: FormData | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: URL, init: RequestInit) => {
      form = init.body as FormData;
      return Response.json({ document: { documentId: "fixture", status: "pending_processing" } });
    })
  );

  await uploadFixture(
    "https://hub.example.test/",
    { authorization: "Bearer synthetic-test-token" },
    "fixtures/evidence/kitchen-sop.md",
    "Staging Kitchen SOP",
    "staging-smoke-category"
  );

  expect(form?.get("categoryId")).toBe("staging-smoke-category");
  expect(JSON.parse(String(form?.get("scopes")))).toEqual([
    { enterpriseKey: "staging_fixture_smoke", ownership: "group", dimensions: {} }
  ]);
  expect(form?.get("confidentialityLevel")).toBe("0");
  expect(form?.get("sourceSystem")).toBe("staging_fixture_smoke");
  expect(form?.get("file")).toBeInstanceOf(Blob);
});
