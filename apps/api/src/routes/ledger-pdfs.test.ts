import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { buildApiServer } from "../server.js";
import type { AuthenticatedEmployee } from "@smedc/domain";
import { registerLedgerPdfRoutes } from "./ledger-pdfs.js";
import type { LedgerPdfDelivery } from "@smedc/ledger-archive/delivery";
const employee: AuthenticatedEmployee = {
  id: "e",
  orgId: "org",
  clearance: 0,
  role: "employee",
  disabled: false,
  organizationName: "Org",
  displayName: "E",
  email: "synthetic.invalid"
};
function fixture(enabled = true, role: "employee" | "admin" = "employee") {
  const delivery = {
    coverage: vi.fn(async () => ({
      scope: { dates: ["2026-10-01"] },
      partitions: [],
      nextCursor: null
    })),
    refresh: vi.fn(async () => ({ requestId: "r", status: "queued" })),
    requestLedgerBundle: vi.fn(async () => ({ requestId: "b", status: "queued" })),
    status: vi.fn(async () => ({
      requestId: "r",
      status: "succeeded",
      partitions: [],
      nextCursor: null
    })),
    issueLedgerBundleUrl: vi.fn(async () => ({
      requestId: "b",
      downloadUrl: "https://signed.invalid",
      expiresAt: "2026-10-04"
    }))
  } satisfies LedgerPdfDelivery;
  const app = Fastify();
  registerLedgerPdfRoutes(app, {
    ledgerPdfDeliveryEnabled: enabled,
    delivery: () => delivery,
    auth: {
      authenticate: async (request, reply) => {
        if (request.headers.authorization !== "Bearer synthetic") {
          reply.code(401).send({ error: { code: "UNAUTHENTICATED" } });
          return false;
        }
        return true;
      },
      employee: () => ({ ...employee, role })
    }
  });
  return { app, delivery };
}
const action = { storeNames: [" 店 / % .. "], dates: ["2026-10-01"], idempotencyKey: "key" };
const headers = { authorization: "Bearer synthetic" };
describe("ledger PDF HTTP contracts", () => {
  it("authenticates all five routes before delivery", async () => {
    const f = fixture();
    for (const [method, url, payload] of [
      ["POST", "/v1/ledger-pdfs/coverage", action],
      ["POST", "/v1/ledger-pdfs/refresh", action],
      ["POST", "/v1/ledger-pdfs/downloads", action],
      ["GET", "/v1/ledger-pdfs/requests/r", undefined],
      ["POST", "/v1/ledger-pdfs/requests/r/download-url", undefined]
    ] as const) {
      const response = await f.app.inject({ method, url, ...(payload ? { payload } : {}) });
      expect(response.statusCode).toBe(401);
    }
    expect(f.delivery.coverage).not.toHaveBeenCalled();
    await f.app.close();
  });
  it("uses the same flag and blocks every new endpoint with 503", async () => {
    const f = fixture(false);
    for (const [method, url] of [
      ["POST", "/v1/ledger-pdfs/coverage"],
      ["POST", "/v1/ledger-pdfs/refresh"],
      ["POST", "/v1/ledger-pdfs/downloads"],
      ["GET", "/v1/ledger-pdfs/requests/r"],
      ["POST", "/v1/ledger-pdfs/requests/r/download-url"]
    ] as const) {
      const r = await f.app.inject({ method, url, headers });
      expect(r.statusCode).toBe(503);
      expect(r.json().error.code).toBe("LEDGER_PDF_NOT_ENABLED");
    }
    await f.app.close();
  });
  it("strictly validates calendar XOR dates, unknown orgId, queries and bodies", async () => {
    const f = fixture();
    for (const payload of [
      { ...action, orgId: "other" },
      { ...action, dates: ["2026-02-29"] },
      { ...action, startDate: "2026-01-01", endDate: "2026-01-02" },
      { ...action, dates: undefined, startDate: "2026-10-04", endDate: "2026-10-01" },
      { ...action, storeNames: [" "] }
    ]) {
      expect(
        (await f.app.inject({ method: "POST", url: "/v1/ledger-pdfs/downloads", headers, payload }))
          .statusCode
      ).toBe(400);
    }
    expect(
      (
        await f.app.inject({
          method: "GET",
          url: "/v1/ledger-pdfs/requests/r?orgId=other",
          headers
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/ledger-pdfs/requests/r/download-url",
          headers,
          payload: {}
        })
      ).statusCode
    ).toBe(400);
    await f.app.close();
  });
  it("enforces admin refresh and forwards org exclusively from authentication", async () => {
    const f = fixture();
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/ledger-pdfs/refresh",
          headers,
          payload: action
        })
      ).statusCode
    ).toBe(403);
    expect(f.delivery.refresh).not.toHaveBeenCalled();
    const a = fixture(true, "admin");
    expect(
      (
        await a.app.inject({
          method: "POST",
          url: "/v1/ledger-pdfs/refresh",
          headers,
          payload: action
        })
      ).statusCode
    ).toBe(202);
    expect(a.delivery.refresh).toHaveBeenCalledWith({
      employee: { ...employee, role: "admin" },
      scope: { storeNames: action.storeNames, dates: action.dates },
      idempotencyKey: "key"
    });
    await f.app.close();
    await a.app.close();
  });
  it("supports omitted coverage stores and exact names with fixed wire responses", async () => {
    const f = fixture();
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/ledger-pdfs/coverage",
          headers,
          payload: { dates: action.dates }
        })
      ).statusCode
    ).toBe(200);
    expect(f.delivery.coverage).toHaveBeenCalledWith({ employee, scope: { dates: action.dates } });
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/ledger-pdfs/downloads",
          headers,
          payload: action
        })
      ).statusCode
    ).toBe(202);
    expect(
      (await f.app.inject({ method: "GET", url: "/v1/ledger-pdfs/requests/r", headers })).json()
    ).not.toHaveProperty("downloadUrl");
    await f.app.close();
  });
  it("returns indistinguishable unavailable and safe internal errors", async () => {
    const f = fixture();
    f.delivery.status
      .mockRejectedValueOnce(new Error("LEDGER_PDF_UNAVAILABLE"))
      .mockRejectedValueOnce(new Error("secret-db-password"));
    const unavailable = await f.app.inject({
      method: "GET",
      url: "/v1/ledger-pdfs/requests/r",
      headers
    });
    expect(unavailable.statusCode).toBe(404);
    const failed = await f.app.inject({
      method: "GET",
      url: "/v1/ledger-pdfs/requests/r",
      headers
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain("secret");
    await f.app.close();
  });
  it("wires the injectable delivery service through the actual API context and server", async () => {
    const f = fixture();
    const app = buildApiServer({
      logger: false,
      authenticateAccessToken: async () => employee,
      ledgerPdfDelivery: f.delivery,
      cursorSigningSecret: "secret",
      runtimeEnv: { LEDGER_PDF_DELIVERY_ENABLED: "true" }
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/ledger-pdfs/coverage",
      headers,
      payload: { dates: action.dates }
    });
    expect(response.statusCode).toBe(200);
    expect(f.delivery.coverage).toHaveBeenCalledWith({ employee, scope: { dates: action.dates } });
    await app.close();
    await f.app.close();
  });
});
