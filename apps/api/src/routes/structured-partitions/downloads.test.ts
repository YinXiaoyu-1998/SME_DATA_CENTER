import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  PartitionDownloadRepositoryError,
  type CurrentPartitionDownload,
  type PartitionDownloadRepository,
  type PartitionDownloadStatus
} from "@smedc/db";
import { loadPartitionDownloadLimits } from "@smedc/domain";
import type { StorageAdapter } from "@smedc/storage";
import { buildApiServer } from "../../server.js";
import type { RequestAuth } from "../../request-auth.js";
import { registerPartitionDownloadRoutes } from "./downloads.js";

const actor = {
  id: "emp_1",
  orgId: "org_1",
  clearance: 1,
  disabled: false,
  role: "employee" as const,
  organizationName: "Synthetic Organization",
  displayName: "Synthetic Employee",
  email: "synthetic@example.invalid"
};
const scope = {
  dataset: "business" as const,
  enterpriseName: "Synthetic",
  enterpriseKey: "synthetic",
  startDate: "2026-10-01",
  endDate: "2026-10-02",
  storeNameContains: ["A"]
};
const body = {
  dataset: scope.dataset,
  enterpriseName: scope.enterpriseName,
  startDate: scope.startDate,
  endDate: scope.endDate,
  storeNameContains: [" A "],
  idempotencyKey: "idem-1"
};
const now = new Date("2026-10-08T10:00:00Z");
function status(overrides: Partial<PartitionDownloadStatus> = {}): PartitionDownloadStatus {
  return {
    requestId: "pd_1",
    status: "queued",
    partitionCount: 2,
    completedPartitionCount: 0,
    totalRowCount: "9007199254740993",
    totalByteSize: "42",
    retryAfterSeconds: 2,
    errorCode: null,
    expiresAt: new Date(now.getTime() + 86_400_000),
    ...overrides
  };
}
function current(overrides: Partial<CurrentPartitionDownload> = {}): CurrentPartitionDownload {
  return {
    request: status({ status: "succeeded", completedPartitionCount: 2 }),
    requester: actor,
    scope,
    manifest: [],
    limits: loadPartitionDownloadLimits({}),
    artifact: {
      objectKey: "private/object.zip",
      byteSize: 200n,
      checksumSha256: "a".repeat(64),
      expiresAt: new Date(now.getTime() + 60_500)
    },
    ...overrides
  };
}
function setup(overrides: Partial<PartitionDownloadRepository> = {}, employee = actor) {
  const unused = async () => {
    throw new Error("unused");
  };
  const repository: PartitionDownloadRepository = {
    prepare: vi.fn(async () => status()),
    read: vi.fn(async () => status()),
    validateCurrent: vi.fn(async () => current()),
    issueCurrent: async (actor, requestId, issue) =>
      issue(await repository.validateCurrent(actor, requestId)),
    markRunning: unused,
    recordProgress: unused,
    fail: unused,
    registerCandidate: unused,
    publish: unused,
    expire: unused,
    disconnect: vi.fn(async () => {}),
    ...overrides
  };
  const audit = { append: vi.fn(async () => {}) };
  const sign = vi.fn(async () => "https://synthetic.invalid/signed");
  const auth = { authenticate: vi.fn(async () => true), employee: () => employee } as RequestAuth;
  const app = Fastify();
  registerPartitionDownloadRoutes(app, {
    auth,
    downloads: () => repository,
    storage: () => ({ createDownloadUrl: sign }) as unknown as StorageAdapter,
    audit: () => audit,
    createBusinessRequestAudit: () => ({
      requestId: "req_test",
      sourceIp: "127.0.0.1",
      clientSource: "http_api",
      launcherVersion: null
    }),
    now: () => now
  });
  return { app, repository, audit, sign, auth };
}

describe("authenticated partition bundle routes", () => {
  it("prepares an authorized normalized scope and returns precision-preserving counts", async () => {
    const { app, repository, audit } = setup();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/structured/partition-downloads",
        payload: body
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        requestId: "pd_1",
        status: "queued",
        totalRowCount: "9007199254740993",
        totalByteSize: "42"
      });
      expect(repository.prepare).toHaveBeenCalledWith(actor, scope, "idem-1");
      expect(audit.append).toHaveBeenCalledWith(
        expect.objectContaining({ action: "prepare", targetId: "pd_1", result: "succeeded" })
      );
      expect(response.body).not.toMatch(/enterpriseKey|objectKey|confidentiality/);
    } finally {
      await app.close();
    }
  });
  it.each(["queued", "running", "succeeded"] as const)(
    "%s status never returns URLs or internal snapshot fields",
    async (state) => {
      const { app, sign } = setup({
        read: vi.fn(async () =>
          status({ status: state, completedPartitionCount: state === "queued" ? 0 : 2 })
        )
      });
      try {
        const response = await app.inject({
          method: "GET",
          url: "/v1/structured/partition-downloads/pd_1"
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().completedPartitionCount).toBe(state === "queued" ? 0 : 2);
        expect(response.body).not.toMatch(/url|objectKey|enterpriseKey/i);
        expect(sign).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );
  it("issues only current succeeded artifacts with TTL bounded by remaining package lifetime", async () => {
    const { app, sign, audit } = setup();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/structured/partition-downloads/pd_1/url"
      });
      expect(response.statusCode).toBe(200);
      expect(sign).toHaveBeenCalledWith("private/object.zip", { expiresInSeconds: 60 });
      expect(response.json()).toMatchObject({
        requestId: "pd_1",
        status: "succeeded",
        scope: {
          dataset: "business",
          enterpriseName: "Synthetic",
          startDate: scope.startDate,
          endDate: scope.endDate,
          storeNameContains: ["A"]
        },
        partitionCount: 2,
        totalRowCount: "9007199254740993",
        totalByteSize: "42",
        byteSize: "200",
        checksumSha256: "a".repeat(64),
        expiresAt: "2026-10-08T10:01:00.500Z",
        urlExpiresAt: "2026-10-08T10:01:00.000Z",
        archiveBounds: {
          maxRawByteSize: "268435456",
          maxManifestByteSize: 8388608,
          maxZipByteSize: "276829696"
        }
      });
      expect(response.body).not.toMatch(
        /objectKey|enterpriseKey|confidentiality|requester|manifest/
      );
      expect(JSON.stringify(audit.append.mock.calls)).not.toContain("synthetic.invalid");
      expect(JSON.stringify(audit.append.mock.calls)).not.toContain("private/object");
    } finally {
      await app.close();
    }
  });
  it("returns safe scope and zero counts without artifact or URL for empty success", async () => {
    const zero = current({
      request: status({
        status: "succeeded",
        partitionCount: 0,
        completedPartitionCount: 0,
        totalRowCount: "0",
        totalByteSize: "0",
        retryAfterSeconds: 0
      }),
      artifact: null
    });
    const { app, sign } = setup({ validateCurrent: async () => zero });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/structured/partition-downloads/pd_1/url"
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        scope: { dataset: "business" },
        partitionCount: 0,
        totalRowCount: "0",
        totalByteSize: "0"
      });
      expect(response.json()).not.toHaveProperty("downloadUrl");
      expect(response.json()).not.toHaveProperty("byteSize");
      expect(sign).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it.each([
    ["PARTITION_DOWNLOAD_FORBIDDEN", 403],
    ["PARTITION_DOWNLOAD_NOT_FOUND", 404],
    ["PARTITION_DOWNLOAD_STALE", 409],
    ["PARTITION_DOWNLOAD_EXPIRED", 410]
  ] as const)("rejects %s before signing", async (code, expected) => {
    const { app, sign } = setup({
      validateCurrent: async () => {
        throw new PartitionDownloadRepositoryError(code);
      }
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/structured/partition-downloads/pd_1/url"
      });
      expect(response.statusCode).toBe(expected);
      expect(response.json().error.code).toBe(code);
      expect(sign).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it.each(["queued", "running"] as const)("rejects URL requests for %s", async (state) => {
    const { app, sign } = setup({
      validateCurrent: async () => current({ request: status({ status: state }) })
    });
    try {
      expect(
        (await app.inject({ method: "POST", url: "/v1/structured/partition-downloads/pd_1/url" }))
          .statusCode
      ).toBe(409);
      expect(sign).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("caps URL lifetime at 900 seconds and rejects subsecond expiry", async () => {
    let value = current({
      artifact: { ...current().artifact!, expiresAt: new Date(now.getTime() + 86_400_000) }
    });
    const { app, sign } = setup({ validateCurrent: async () => value });
    try {
      await app.inject({ method: "POST", url: "/v1/structured/partition-downloads/pd_1/url" });
      expect(sign).toHaveBeenLastCalledWith("private/object.zip", { expiresInSeconds: 900 });
      value = current({
        artifact: { ...current().artifact!, expiresAt: new Date(now.getTime() + 999) }
      });
      expect(
        (await app.inject({ method: "POST", url: "/v1/structured/partition-downloads/pd_1/url" }))
          .statusCode
      ).toBe(410);
      expect(sign).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it("rejects disabled actors before touching repositories", async () => {
    const { app, repository, sign } = setup({}, { ...actor, disabled: true });
    try {
      expect(
        (await app.inject({ method: "POST", url: "/v1/structured/partition-downloads/pd_1/url" }))
          .statusCode
      ).toBe(403);
      expect(repository.validateCurrent).not.toHaveBeenCalled();
      expect(sign).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("rejects mixed/unknown selectors and malformed scope before preparing", async () => {
    const { app, repository } = setup();
    try {
      for (const payload of [
        { ...body, requestId: "pd_1" },
        { ...body, orgId: "other" },
        { ...body, storeNameContains: [] },
        { ...body, storeIds: [42] },
        { ...body, startDate: "2026-02-30" },
        { ...body, idempotencyKey: " padded " }
      ]) {
        expect(
          (await app.inject({ method: "POST", url: "/v1/structured/partition-downloads", payload }))
            .statusCode
        ).toBe(400);
      }
      expect(repository.prepare).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("offers a safe smaller-scope suggestion on size limits", async () => {
    const { app } = setup({
      prepare: async () => {
        throw new PartitionDownloadRepositoryError("PARTITION_DOWNLOAD_LIMIT_EXCEEDED");
      }
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/structured/partition-downloads",
        payload: body
      });
      expect(response.statusCode).toBe(413);
      expect(response.json().error.message).toMatch(/narrow.*date.*store/i);
    } finally {
      await app.close();
    }
  });
});

it("wires all three routes into the server and enforces bearer authentication before repository access", async () => {
  const { app: fixture, repository, audit, sign } = setup();
  await fixture.close();
  const app = buildApiServer({
    logger: false,
    cursorSigningSecret: "synthetic-secret",
    authenticateAccessToken: async (token) =>
      token === "valid" ? actor : token === "disabled" ? { ...actor, disabled: true } : null,
    partitionDownloadRepository: repository,
    partitionDownloadAuditRepository: audit,
    storageAdapter: { createDownloadUrl: sign } as unknown as StorageAdapter
  });
  try {
    for (const route of [
      { method: "POST" as const, url: "/v1/structured/partition-downloads", payload: body },
      { method: "GET" as const, url: "/v1/structured/partition-downloads/pd_1" },
      { method: "POST" as const, url: "/v1/structured/partition-downloads/pd_1/url" }
    ]) {
      expect((await app.inject(route)).statusCode).toBe(401);
      expect(
        (await app.inject({ ...route, headers: { authorization: "Bearer disabled" } })).statusCode
      ).toBe(403);
    }
    expect(repository.prepare).not.toHaveBeenCalled();
    expect(repository.read).not.toHaveBeenCalled();
    expect(repository.validateCurrent).not.toHaveBeenCalled();
    const created = await app.inject({
      method: "POST",
      url: "/v1/structured/partition-downloads",
      payload: body,
      headers: { authorization: "Bearer valid", "x-request-id": "req_prepare" }
    });
    expect(created.statusCode).toBe(202);
    expect(created.json().requestId).toBe("pd_1");
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: expect.objectContaining({ requestId: "req_prepare", clientSource: "http_api" })
      })
    );
  } finally {
    await app.close();
  }
});

it.each([
  ["lowered clearance", { ...actor, clearance: 0 }, "PARTITION_DOWNLOAD_FORBIDDEN", 403],
  ["another organization", { ...actor, orgId: "org_other" }, "PARTITION_DOWNLOAD_NOT_FOUND", 404]
] as const)(
  "passes current %s authority to the repository before URL issuance",
  async (_label, employee, code, expected) => {
    const validateCurrent = vi.fn(async () => {
      throw new PartitionDownloadRepositoryError(code);
    });
    const { app, sign } = setup({ validateCurrent }, employee);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/structured/partition-downloads/pd_1/url"
      });
      expect(validateCurrent).toHaveBeenCalledWith(employee, "pd_1");
      expect(response.statusCode).toBe(expected);
      expect(response.json().error.code).toBe(code);
      expect(sign).not.toHaveBeenCalled();
      expect(response.body).not.toContain("private");
    } finally {
      await app.close();
    }
  }
);
