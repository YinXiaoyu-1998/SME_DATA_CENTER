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
import { getWebApiRoute } from "@smedc/web-api-contract";
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
import { registerApiErrorHandler } from "../request-errors.js";
import { registerWebSessionRoutes } from "../web-api/session.js";
import { registerLedgerWebRoutes } from "./routes.js";

const origin = "https://api.smedatacenter.xyz";
const password = "synthetic password";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const fingerprint = "a".repeat(64);

function expectContract(id: string, body: unknown) {
  const route = getWebApiRoute(id);
  const parsed = route.response.safeParse(body);
  expect(parsed.success, `${id} response must satisfy its contract`).toBe(true);
}

function errorCode(response: { json(): { error?: { code?: string } } }) {
  return response.json().error?.code;
}

async function fixture(overrides: { ledgerPdfDeliveryEnabled?: boolean } = {}) {
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
    async verifyLogin(email, candidate) {
      return email === principal.email && candidate === password
        ? {
            ok: true,
            identityId: principal.identityId,
            userAccountId: principal.id,
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
        userAccountId: input.employee.id,
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
      return bundle && bundle.orgId === e.orgId && bundle.userAccountId === e.id
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
      return { state: "found", size: pdf.length, hash: "c".repeat(64) };
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
  const app = Fastify({ logger: false });
  apps.push(app);
  registerApiErrorHandler(app);
  registerWebSessionRoutes(app, { auth, browserSessions: sessions, webOrigin: origin });
  registerLedgerWebRoutes(app, {
    auth,
    browserSessions: sessions,
    webOrigin: origin,
    ledgerPdfDeliveryEnabled: overrides.ledgerPdfDeliveryEnabled ?? true,
    delivery: () => delivery
  });
  await app.ready();
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

/** 共享会话登录：台账不再有自己的登录页，浏览器先拿 /api/web/v1/session 的 Cookie 与 CSRF。 */
async function login(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.app.inject({
    method: "POST",
    url: "/api/web/v1/session",
    headers: { origin },
    payload: { email: f.principal.email, password }
  });
  expect(response.statusCode).toBe(200);
  const cookie = pair(response.headers["set-cookie"], BROWSER_SESSION_COOKIE);
  return { response, cookie, csrfToken: response.json().csrfToken as string };
}

function headersFor(cookie: string, csrfToken?: string) {
  return {
    cookie,
    origin,
    ...(csrfToken === undefined ? {} : { "x-csrf-token": csrfToken })
  };
}

const ledgerRoutes = [
  ["GET", "/api/web/v1/ledger/context"],
  ["POST", "/api/web/v1/ledger/coverage"],
  ["GET", "/api/web/v1/ledger/pdf?storeName=x&purchaseDate=2026-10-01&disposition=inline"],
  ["POST", "/api/web/v1/ledger/downloads"],
  ["GET", "/api/web/v1/ledger/requests/req"],
  ["POST", "/api/web/v1/ledger/requests/req/download-url"]
] as const;

describe("ledger download center browser boundary", () => {
  it("exposes only the new browser paths and removes the rendered page/login/logout routes", async () => {
    const f = await fixture();
    for (const [method, url] of [
      ["GET", "/ledger-pdfs"],
      ["GET", "/ledger-pdfs/login"],
      ["POST", "/ledger-pdfs/login"],
      ["POST", "/ledger-pdfs/logout"],
      ["GET", "/ledger-pdfs/api/context"],
      ["POST", "/ledger-pdfs/api/coverage"]
    ] as const) {
      const response = await f.app.inject({ method, url });
      expect(response.statusCode, `${method} ${url} must be gone`).toBe(404);
    }
  });

  it("rejects every ledger route without a browser session using 401 and the shared error envelope", async () => {
    const f = await fixture();
    for (const [method, url] of ledgerRoutes) {
      const response = await f.app.inject({
        method,
        url,
        ...(method === "POST"
          ? { headers: { origin }, payload: { selection: [], idempotencyKey: "k" } }
          : {})
      });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(errorCode(response)).toBe("BROWSER_SIGN_IN_REQUIRED");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("returns the shared-session identity, CSRF token and limits in a contract-parseable context", async () => {
    const f = await fixture();
    const { cookie, csrfToken } = await login(f);
    const context = await f.app.inject({
      method: "GET",
      url: "/api/web/v1/ledger/context",
      headers: { cookie }
    });
    expect(context.statusCode).toBe(200);
    const body = context.json();
    expect(body).toEqual({
      identity: {
        userAccountId: "employee",
        orgId: "org",
        displayName: "员工 <测试>",
        organizationName: "企业"
      },
      csrfToken: csrfTokenForSecret(cookie.slice(cookie.indexOf("=") + 1)),
      limits: {
        files: 5000,
        bytes: 1073741824,
        stores: 50,
        dates: 366,
        pageSize: 200,
        deadlineMs: 600000,
        retentionMs: 86400000
      }
    });
    expect(body.csrfToken).toBe(csrfToken);
    expect(context.body).not.toContain("credentialFingerprint");
    expect(context.body).not.toContain("identityId");
    expect(context.body).not.toContain("email");
    expect(context.headers["x-content-type-options"]).toBe("nosniff");
    expectContract("ledger.context", body);

    f.expire();
    const expired = await f.app.inject({
      method: "GET",
      url: "/api/web/v1/ledger/context",
      headers: { cookie }
    });
    expect(expired.statusCode).toBe(401);
    expect(errorCode(expired)).toBe("BROWSER_SIGN_IN_REQUIRED");
  });

  it("requires same-origin Origin and a matching CSRF token on every ledger write", async () => {
    const f = await fixture();
    const { cookie, csrfToken } = await login(f);
    const writeRoutes = [
      [
        "/api/web/v1/ledger/coverage",
        { scope: { startDate: "2026-10-01", endDate: "2026-10-04" } }
      ],
      ["/api/web/v1/ledger/downloads", { selection: [], idempotencyKey: "k" }],
      ["/api/web/v1/ledger/requests/req/download-url", undefined]
    ] as const;
    for (const [url, payload] of writeRoutes) {
      for (const headers of [
        { cookie },
        { cookie, origin: "https://evil.invalid", "x-csrf-token": csrfToken },
        { cookie, origin }
      ]) {
        const response = await f.app.inject({
          method: "POST",
          url,
          headers,
          ...(payload === undefined ? {} : { payload })
        });
        expect(response.statusCode, url).toBe(403);
        expect(errorCode(response)).toBe("BROWSER_SECURITY_CHECK_FAILED");
      }
    }
  });

  it("reads real coverage with sizes, rejects client authority and fails closed without content authorization", async () => {
    const f = await fixture();
    const { cookie, csrfToken } = await login(f);
    const headers = headersFor(cookie, csrfToken);
    const payload = { scope: { startDate: "2026-10-01", endDate: "2026-10-04" } };
    const response = await f.app.inject({
      method: "POST",
      url: "/api/web/v1/ledger/coverage",
      headers,
      payload
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({
      partitions: [
        { storeName: " 店 é ", purchaseDate: "2026-10-01", status: "ready", byteSize: 14 },
        { storeName: " 店 é ", purchaseDate: "2026-10-02", status: "pending", byteSize: null },
        { storeName: " 店 é ", purchaseDate: "2026-10-03", status: "stale", byteSize: null },
        { storeName: " 店 é ", purchaseDate: "2026-10-04", status: "missing", byteSize: null }
      ],
      nextCursor: null
    });
    expectContract("ledger.coverage", body);

    for (const extra of [
      { orgId: "other" },
      { objectKey: "private.pdf" },
      { scope: payload.scope, selection: [{ storeName: " 店 é ", purchaseDate: "2026-10-01" }] }
    ]) {
      const rejected = await f.app.inject({
        method: "POST",
        url: "/api/web/v1/ledger/coverage",
        headers,
        payload: { ...payload, ...extra }
      });
      expect(rejected.statusCode).toBe(400);
    }
    const extraQuery = await f.app.inject({
      method: "POST",
      url: "/api/web/v1/ledger/coverage?orgId=other",
      headers,
      payload
    });
    expect(extraQuery.statusCode).toBe(400);
    expect(errorCode(extraQuery)).toBe("WEB_API_INVALID_REQUEST");

    // 无业务授权时列表为空而不是 403：保留原有“不泄露分区存在性”的失败关闭语义。
    f.principal.role = "admin";
    f.revokeRead();
    const empty = await f.app.inject({
      method: "POST",
      url: "/api/web/v1/ledger/coverage",
      headers,
      payload
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ partitions: [], nextCursor: null });
    expectContract("ledger.coverage", empty.json());
  });

  it("streams an authorized PDF inline or as attachment on the same origin and fails closed otherwise", async () => {
    const f = await fixture();
    const { cookie } = await login(f);
    const params = new URLSearchParams({
      storeName: " 店 é ",
      purchaseDate: "2026-10-01",
      disposition: "inline"
    });
    const get = (url: string) => f.app.inject({ method: "GET", url, headers: { cookie } });
    const response = await get("/api/web/v1/ledger/pdf?" + params);
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
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    // 200 且字节一致即证明注册器的响应契约接受了流；下面再固定契约形状本身。
    const pdfContract = getWebApiRoute("ledger.pdf").response;
    expect(pdfContract.safeParse(Readable.from([f.pdf])).success).toBe(true);
    expect(pdfContract.safeParse({ fileName: "x" }).success).toBe(false);
    expect(f.bundles.size).toBe(0);

    params.set("disposition", "attachment");
    expect((await get("/api/web/v1/ledger/pdf?" + params)).headers["content-disposition"]).toMatch(
      /^attachment;/
    );
    params.set("purchaseDate", "2026-10-02");
    const notReady = await get("/api/web/v1/ledger/pdf?" + params);
    expect(notReady.statusCode).toBe(409);
    expect(errorCode(notReady)).toBe("LEDGER_PDF_NOT_READY");
    params.set("purchaseDate", "2026-10-01");
    params.set("extra", "1");
    expect((await get("/api/web/v1/ledger/pdf?" + params)).statusCode).toBe(400);
    params.delete("extra");
    f.revokeRead();
    const unavailable = await get("/api/web/v1/ledger/pdf?" + params);
    expect(unavailable.statusCode).toBe(404);
    expect(errorCode(unavailable)).toBe("LEDGER_PDF_UNAVAILABLE");
  });

  it("prepares ZIPs idempotently, exposes only the caller's status and rechecks authorization for links", async () => {
    const f = await fixture();
    const { cookie, csrfToken } = await login(f);
    const headers = headersFor(cookie, csrfToken);
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
    const post = (url: string, body?: Record<string, unknown>) =>
      f.app.inject({
        method: "POST",
        url: "/api/web/v1/ledger/" + url,
        headers,
        ...(body === undefined ? {} : { payload: body })
      });
    const created = await post("downloads", { selection, idempotencyKey: "exact" });
    expect(created.statusCode).toBe(202);
    const task = created.json();
    expectContract("ledger.downloads", task);
    expect(
      (
        await post("downloads", {
          selection: [...selection].reverse(),
          idempotencyKey: "exact"
        })
      ).json()
    ).toEqual(task);
    const conflict = await post("downloads", {
      selection: [selection[0]],
      idempotencyKey: "exact"
    });
    expect(conflict.statusCode).toBe(409);
    expect(errorCode(conflict)).toBe("LEDGER_IDEMPOTENCY_CONFLICT");

    const status = await f.app.inject({
      method: "GET",
      url: "/api/web/v1/ledger/requests/" + task.requestId,
      headers
    });
    expect(status.statusCode).toBe(200);
    const statusBody = status.json();
    expect(statusBody.partitions).toEqual(selection.map((item) => ({ ...item, status: "queued" })));
    expect(status.body).not.toContain("objectKey");
    expectContract("ledger.requests.read", statusBody);

    const bundle = [...f.bundles.values()][0]!.bundle;
    bundle.status = "succeeded";
    bundle.zipObjectKey = "private.zip";
    bundle.zipExpiresAt = new Date(Date.now() + 600000);
    const link = await post("requests/" + task.requestId + "/download-url");
    expect(link.statusCode).toBe(200);
    expect(link.json()).toHaveProperty("downloadUrl", "https://signed.invalid/download");
    expectContract("ledger.requests.downloadUrl", link.json());

    f.revokeRead();
    const denied = await post("requests/" + task.requestId + "/download-url");
    expect(denied.statusCode).toBe(404);
    expect(errorCode(denied)).toBe("LEDGER_PDF_UNAVAILABLE");
    const stillOwned = await f.app.inject({
      method: "GET",
      url: "/api/web/v1/ledger/requests/" + task.requestId,
      headers
    });
    expect(stillOwned.json().status).toBe("succeeded");

    f.principal.id = "other-account";
    const foreign = await f.app.inject({
      method: "GET",
      url: "/api/web/v1/ledger/requests/" + task.requestId,
      headers
    });
    expect(foreign.statusCode).toBe(404);
    expect(errorCode(foreign)).toBe("LEDGER_PDF_UNAVAILABLE");
  });

  it("accepts the supported 5000-file selection even when exact names exceed the default HTTP body limit", async () => {
    const f = await fixture();
    const { cookie, csrfToken } = await login(f);
    const base = f.facts[0]!;
    f.facts.splice(0);
    for (let i = 0; i < 5000; i++) {
      const key = {
        orgId: "org",
        storeName: "S".repeat(300) + Math.floor(i / 100),
        purchaseDate: new Date(Date.UTC(2026, 0, (i % 100) + 1)).toISOString().slice(0, 10)
      };
      f.facts.push({
        key,
        status: "ready",
        entry: { ...base.entry!, key, partitionId: String(i) }
      });
    }
    const selection = f.facts.map(({ key: { storeName, purchaseDate } }) => ({
      storeName,
      purchaseDate
    }));
    const response = await f.app.inject({
      method: "POST",
      url: "/api/web/v1/ledger/downloads",
      headers: headersFor(cookie, csrfToken),
      payload: { selection, idempotencyKey: "long-selection" }
    });
    expect(response.statusCode).toBe(202);
    expectContract("ledger.downloads", response.json());
  });

  it("returns 503 while ledger delivery is disabled", async () => {
    const f = await fixture({ ledgerPdfDeliveryEnabled: false });
    const { cookie, csrfToken } = await login(f);
    const response = await f.app.inject({
      method: "POST",
      url: "/api/web/v1/ledger/coverage",
      headers: headersFor(cookie, csrfToken),
      payload: { scope: { startDate: "2026-10-01", endDate: "2026-10-04" } }
    });
    expect(response.statusCode).toBe(503);
    expect(errorCode(response)).toBe("LEDGER_PDF_NOT_ENABLED");
  });
});
