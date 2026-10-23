import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import {
  createLedgerPdfDelivery,
  LedgerDeliveryError,
  type LedgerDeliveryRepository,
  type LedgerBundleRecord,
  type LedgerPdfFact
} from "@smedc/ledger-archive/delivery";
import { ledgerScopeDates, parseLedgerScope } from "@smedc/ledger-archive";
import type { StorageAdapter } from "@smedc/storage";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserSessions,
  BROWSER_SESSION_COOKIE,
  type BrowserPrincipal,
  type BrowserSessionRepository
} from "../auth/browser-session.js";
import { csrfTokenForSecret } from "../auth/http-contract.js";
import type { AuthCore } from "../auth/auth-core.js";

const origin = "https://api.smedatacenter.xyz";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const fingerprint = "a".repeat(64);
async function fixture() {
  const principal: BrowserPrincipal = {
    identityId: "identity",
    id: "employee",
    orgId: "org",
    organizationName: "企业",
    displayName: "员工 <测试>",
    email: "e@example.invalid",
    role: "employee",
    clearance: 1,
    disabled: false
  };
  let now = new Date();
  const rows = new Map<string, { expiresAt: Date; revokedAt: Date | null }>();
  const repository: BrowserSessionRepository = {
    async create(input) {
      rows.set(input.secretHash, { expiresAt: input.expiresAt, revokedAt: null });
      return true;
    },
    async find(hash) {
      const row = rows.get(hash);
      return row
        ? {
            ...row,
            principal,
            credentialFingerprint: fingerprint,
            currentCredentialFingerprint: fingerprint
          }
        : null;
    },
    async revoke(hash, at) {
      const row = rows.get(hash);
      if (row) row.revokedAt = at;
    }
  };
  const sessions = new BrowserSessions(repository, () => now);
  const auth: Pick<AuthCore, "verifyLogin"> = {
    async verifyLogin(email, password) {
      return email === principal.email && password === "synthetic password"
        ? {
            ok: true,
            identityId: principal.identityId,
            employeeId: principal.id,
            orgId: principal.orgId,
            credentialFingerprint: fingerprint
          }
        : { ok: false, reason: "invalid_credentials" };
    }
  };
  const pdf = Buffer.from("%PDF-synthetic");
  const facts: LedgerPdfFact[] = ["ready", "pending", "stale", "missing"].map((status, index) => {
    const key = { orgId: "org", storeName: " 店 é ", purchaseDate: `2026-10-0${index + 1}` };
    return {
      key,
      status: status as LedgerPdfFact["status"],
      entry:
        status === "ready"
          ? {
              key,
              partitionId: "partition",
              generation: 1,
              dataRevision: 1,
              sourceFingerprint: "a".repeat(64),
              objectKey: "private.pdf",
              checksumSha256: createHash("sha256").update(pdf).digest("hex"),
              byteSize: pdf.length,
              sources: []
            }
          : null
    };
  });
  let readable = true;
  const bundles = new Map<string, { fingerprint: string; bundle: LedgerBundleRecord }>();
  const deliveryRepository: LedgerDeliveryRepository = {
    async currentEmployee(e) {
      return principal.disabled ? null : { ...e };
    },
    async facts(e, scope) {
      const dates = ledgerScopeDates(
        parseLedgerScope({ ...scope, storeNames: scope.storeNames ?? ["test"] })
      );
      return readable
        ? facts.filter(
            (f) =>
              f.key.orgId === e.orgId &&
              (!scope.storeNames || scope.storeNames.includes(f.key.storeName)) &&
              dates.includes(f.key.purchaseDate)
          )
        : [];
    },
    async reserveBundle(input) {
      const existing = bundles.get(input.idempotencyKey);
      if (existing && existing.fingerprint !== input.fingerprint)
        throw new LedgerDeliveryError("LEDGER_IDEMPOTENCY_CONFLICT");
      const bundle = existing?.bundle ?? {
        requestId: "bundle-" + bundles.size,
        orgId: input.employee.orgId,
        employeeId: input.employee.id,
        status: "queued",
        manifest: input.manifest,
        zipObjectKey: null,
        zipExpiresAt: null,
        errorCode: null
      };
      bundles.set(input.idempotencyKey, { fingerprint: input.fingerprint, bundle });
      return { requestId: bundle.requestId, status: bundle.status };
    },
    async request(e, id) {
      const bundle = [...bundles.values()].find((item) => item.bundle.requestId === id)?.bundle;
      return bundle && bundle.orgId === e.orgId && bundle.employeeId === e.id
        ? {
            kind: "download",
            status: bundle.status,
            scope: bundle.manifest.scope,
            items: [],
            bundle
          }
        : null;
    }
  };
  const storage = {
    async getObjectStream() {
      return Readable.from([pdf]);
    },
    async headObject() {
      return { state: "found", size: pdf.length };
    },
    async createDownloadUrl() {
      return "https://signed.invalid/download";
    }
  } as unknown as StorageAdapter;
  const delivery = createLedgerPdfDelivery({
    repository: deliveryRepository,
    storage,
    cursorSecret: "test-secret",
    now: () => now
  });
  const module = await import("./routes.js").catch(() => null);
  expect(module, "ledger browser routes must exist").not.toBeNull();
  const app = Fastify({ logger: false });
  apps.push(app);
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string)))
  );
  module!.registerLedgerWebRoutes(app, {
    auth,
    browserSessions: sessions,
    publicOrigin: origin,
    ledgerPdfDeliveryEnabled: true,
    delivery: () => delivery
  });
  return {
    app,
    principal,
    sessions,
    facts,
    pdf,
    bundles,
    revokeRead() {
      readable = false;
    },
    expire() {
      now = new Date(now.getTime() + 604800000);
    }
  };
}
function pair(value: string | string[] | undefined, name: string) {
  return (Array.isArray(value) ? value : [value ?? ""])
    .find((v) => v.startsWith(name + "="))!
    .split(";")[0]!;
}
async function login(f: Awaited<ReturnType<typeof fixture>>) {
  const page = await f.app.inject({ method: "GET", url: "/ledger-pdfs/login" });
  const cookie = pair(page.headers["set-cookie"], "__Host-smedc_ledger_login");
  const csrfToken = page.body.match(/name="csrfToken" value="([^"]+)"/)![1]!;
  const response = await f.app.inject({
    method: "POST",
    url: "/ledger-pdfs/login",
    headers: { cookie, origin },
    payload: { email: f.principal.email, password: "synthetic password", csrfToken }
  });
  return { response, cookie: pair(response.headers["set-cookie"], BROWSER_SESSION_COOKIE) };
}
describe("ledger download center browser boundary", () => {
  it("allows an ordinary employee to sign in, shares the week-long cookie, and exposes only safe current context", async () => {
    const f = await fixture();
    const entry = await f.app.inject({ method: "GET", url: "/ledger-pdfs" });
    expect(entry.statusCode).toBe(303);
    expect(entry.headers.location).toBe("/ledger-pdfs/login");
    const { response, cookie } = await login(f);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/ledger-pdfs");
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("Max-Age=604800")])
    );
    const context = await f.app.inject({
      method: "GET",
      url: "/ledger-pdfs/api/context",
      headers: { cookie }
    });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({
      identity: {
        employeeId: "employee",
        orgId: "org",
        displayName: "员工 <测试>",
        organizationName: "企业"
      },
      csrfToken: csrfTokenForSecret(cookie.slice(cookie.indexOf("=") + 1)),
      limits: { files: 5000, bytes: 1073741824, stores: 50, dates: 366, pageSize: 200 }
    });
    expect(context.body).not.toContain("credentialFingerprint");
    expect(context.body).not.toContain("identityId");
    const page = await f.app.inject({ method: "GET", url: "/ledger-pdfs", headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("台账 PDF");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["content-security-policy"]).toContain("frame-src 'self'");
    f.expire();
    expect(
      (await f.app.inject({ method: "GET", url: "/ledger-pdfs/api/context", headers: { cookie } }))
        .statusCode
    ).toBe(401);
  });
});

it("reads real coverage with sizes, rejects client authority and requires cookie plus Origin/CSRF even for coverage", async () => {
  const f = await fixture();
  const { cookie } = await login(f);
  const csrf = csrfTokenForSecret(cookie.slice(cookie.indexOf("=") + 1));
  const headers = { cookie, origin, "x-csrf-token": csrf };
  const payload = { scope: { startDate: "2026-10-01", endDate: "2026-10-04" } };
  const response = await f.app.inject({
    method: "POST",
    url: "/ledger-pdfs/api/coverage",
    headers,
    payload
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().partitions).toEqual([
    { storeName: " 店 é ", purchaseDate: "2026-10-01", status: "ready", byteSize: 14 },
    { storeName: " 店 é ", purchaseDate: "2026-10-02", status: "pending", byteSize: null },
    { storeName: " 店 é ", purchaseDate: "2026-10-03", status: "stale", byteSize: null },
    { storeName: " 店 é ", purchaseDate: "2026-10-04", status: "missing", byteSize: null }
  ]);
  for (const invalidHeaders of [{ cookie }, { ...headers, origin: "https://evil.invalid" }])
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/ledger-pdfs/api/coverage",
          headers: invalidHeaders,
          payload
        })
      ).statusCode
    ).toBe(403);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: "/ledger-pdfs/api/coverage",
        headers: { authorization: "Bearer synthetic" },
        payload
      })
    ).statusCode
  ).toBe(401);
  for (const extra of [{ orgId: "other" }, { objectKey: "private.pdf" }, { selection: [] }])
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/ledger-pdfs/api/coverage",
          headers,
          payload: { ...payload, ...extra }
        })
      ).statusCode
    ).toBe(400);
  f.principal.role = "admin";
  f.revokeRead();
  expect(
    (
      await f.app.inject({ method: "POST", url: "/ledger-pdfs/api/coverage", headers, payload })
    ).json().partitions
  ).toEqual([]);
});
it("streams an authorized PDF inline or as attachment without creating a ZIP and refuses revoked content", async () => {
  const f = await fixture();
  const { cookie } = await login(f);
  const params = new URLSearchParams({
    storeName: " 店 é ",
    purchaseDate: "2026-10-01",
    disposition: "inline"
  });
  const get = (url: string) => f.app.inject({ method: "GET", url, headers: { cookie } });
  const response = await get("/ledger-pdfs/api/pdf?" + params);
  expect(response.statusCode).toBe(200);
  expect(response.rawPayload).toEqual(f.pdf);
  expect(response.headers["content-type"]).toBe("application/pdf");
  expect(response.headers["content-disposition"]).toContain(
    "inline; filename=\"ledger.pdf\"; filename*=UTF-8''"
  );
  expect(response.headers["content-disposition"]).toContain(
    encodeURIComponent("食品经营单位进货台帐_ 店 é%20_2026-10-01.pdf")
  );
  expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
  expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(f.bundles.size).toBe(0);
  params.set("disposition", "attachment");
  expect((await get("/ledger-pdfs/api/pdf?" + params)).headers["content-disposition"]).toMatch(
    /^attachment;/
  );
  params.set("purchaseDate", "2026-10-02");
  expect((await get("/ledger-pdfs/api/pdf?" + params)).statusCode).toBe(409);
  params.set("purchaseDate", "2026-10-01");
  f.revokeRead();
  expect((await get("/ledger-pdfs/api/pdf?" + params)).statusCode).toBe(404);
});
it("submits only exact pairs, retries idempotently, limits own status and rechecks permissions for links", async () => {
  const f = await fixture();
  const { cookie } = await login(f);
  const headers = {
    cookie,
    origin,
    "x-csrf-token": csrfTokenForSecret(cookie.slice(cookie.indexOf("=") + 1))
  };
  const first = f.facts[0]!;
  const second = {
    ...first,
    key: { ...first.key, storeName: "Other", purchaseDate: "2026-10-02" },
    entry: {
      ...first.entry!,
      key: { ...first.key, storeName: "Other", purchaseDate: "2026-10-02" },
      partitionId: "other"
    }
  };
  f.facts.push(second);
  const selection = [first.key, second.key].map(({ storeName, purchaseDate }) => ({
    storeName,
    purchaseDate
  }));
  const post = (url: string, payload?: Record<string, unknown>) =>
    f.app.inject({
      method: "POST",
      url: "/ledger-pdfs/api/" + url,
      headers,
      ...(payload === undefined ? {} : { payload })
    });
  const created = await post("downloads", { selection, idempotencyKey: "exact" });
  expect(created.statusCode).toBe(202);
  const task = created.json();
  expect(
    (
      await post("downloads", { selection: [...selection].reverse(), idempotencyKey: "exact" })
    ).json()
  ).toEqual(task);
  expect(
    (await post("downloads", { selection: [selection[0]], idempotencyKey: "exact" })).statusCode
  ).toBe(409);
  const status = await f.app.inject({
    method: "GET",
    url: `/ledger-pdfs/api/requests/${task.requestId}`,
    headers
  });
  expect(status.json().partitions).toEqual(
    selection.map((item) => ({ ...item, status: "queued" }))
  );
  expect(status.body).not.toContain("objectKey");
  const bundle = [...f.bundles.values()][0]!.bundle;
  bundle.status = "succeeded";
  bundle.zipObjectKey = "private.zip";
  bundle.zipExpiresAt = new Date(Date.now() + 600000);
  expect((await post(`requests/${task.requestId}/download-url`)).json()).toHaveProperty(
    "downloadUrl",
    "https://signed.invalid/download"
  );
  f.revokeRead();
  expect((await post(`requests/${task.requestId}/download-url`)).statusCode).toBe(404);
  expect(
    (
      await f.app.inject({
        method: "GET",
        url: `/ledger-pdfs/api/requests/${task.requestId}`,
        headers
      })
    ).json().status
  ).toBe("succeeded");
  f.principal.id = "other-account";
  expect(
    (
      await f.app.inject({
        method: "GET",
        url: `/ledger-pdfs/api/requests/${task.requestId}`,
        headers
      })
    ).statusCode
  ).toBe(404);
});
it("requires same-origin logout, revokes the cookie, and does not authorize bearer-only browsers", async () => {
  const f = await fixture();
  const { cookie } = await login(f);
  const csrf = csrfTokenForSecret(cookie.slice(cookie.indexOf("=") + 1));
  const rejected = await f.app.inject({
    method: "POST",
    url: "/ledger-pdfs/logout",
    headers: { cookie, origin: "https://evil.invalid", "x-csrf-token": csrf }
  });
  expect(rejected.statusCode).toBe(403);
  const logout = await f.app.inject({
    method: "POST",
    url: "/ledger-pdfs/logout",
    headers: { cookie, origin, "x-csrf-token": csrf }
  });
  expect(logout.statusCode).toBe(200);
  expect(logout.headers["set-cookie"]).toContain("Max-Age=0");
  expect(
    (await f.app.inject({ method: "GET", url: "/ledger-pdfs/api/context", headers: { cookie } }))
      .statusCode
  ).toBe(401);
});
it("accepts the supported 5000-file selection even when exact names exceed the default HTTP body limit", async () => {
  const f = await fixture();
  const { cookie } = await login(f);
  const base = f.facts[0]!;
  f.facts.splice(0);
  for (let i = 0; i < 5000; i++) {
    const key = {
      orgId: "org",
      storeName: "S".repeat(300) + Math.floor(i / 100),
      purchaseDate: new Date(Date.UTC(2026, 0, (i % 100) + 1)).toISOString().slice(0, 10)
    };
    f.facts.push({ key, status: "ready", entry: { ...base.entry!, key, partitionId: String(i) } });
  }
  const selection = f.facts.map(({ key: { storeName, purchaseDate } }) => ({
    storeName,
    purchaseDate
  }));
  const response = await f.app.inject({
    method: "POST",
    url: "/ledger-pdfs/api/downloads",
    headers: {
      cookie,
      origin,
      "x-csrf-token": csrfTokenForSecret(cookie.slice(cookie.indexOf("=") + 1))
    },
    payload: { selection, idempotencyKey: "long-selection" }
  });
  expect(response.statusCode).toBe(202);
});
