import { legacyPermissionService } from "../business-authorization.test-support.js";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { PHASE3_ERROR_CODES, type AuthenticatedEmployee } from "@smedc/domain";
import type { StructuredCoverageRepository } from "../structured-coverage.js";
import type { StructuredQueryRepository } from "../structured-query.js";
import type { ApiServerContext } from "../app-context.js";
import { createRequestAuth } from "../request-auth.js";
import { registerStructuredQueryRoutes } from "./structured-query.js";

const employee: AuthenticatedEmployee = {
  id: "emp_1",
  orgId: "default-org",
  organizationName: "Default Organization",
  displayName: "Employee One",
  email: "employee@example.com",
  role: "employee",
  disabled: false,
  clearance: 3
};

function unexpectedDependency(): never {
  throw new Error("Unexpected dependency in structured query route test");
}

function context(
  repository: StructuredQueryRepository,
  coverageRepository: StructuredCoverageRepository = {
    list: async () => ({
      dataset: "vip",
      metadataPolicy: "window",
      sources: []
    })
  }
): ApiServerContext {
  return {
    permissions: () => legacyPermissionService(employee),
    environment: {},
    delegationProof: "proof",
    runtimeLimits: {} as ApiServerContext["runtimeLimits"],
    cursorSigningSecret: "cursor-secret",
    readinessCheck: async () => ({ ok: true, checks: [] }) as never,
    authCore: undefined,
    authenticateOfficialAccessToken: async (token) => (token === "valid" ? employee : null),
    authenticationClientSource: () => "http_api",
    createBusinessRequestAudit: unexpectedDependency,
    documents: unexpectedDependency,
    storage: unexpectedDependency,
    structuredImports: unexpectedDependency,
    structuredPartitions: unexpectedDependency,
    partitionDownloads: unexpectedDependency,
    partitionDownloadAudit: unexpectedDependency,
    structuredQueries: () => repository,
    structuredCoverage: () => coverageRepository,
    skills: unexpectedDependency,
    ledgerPdfs: () => {
      throw new Error("Unexpected ledger PDF dependency");
    },
    evidence: unexpectedDependency,
    uploadAuthorizationAudit: unexpectedDependency,
    quarantineCertificates: unexpectedDependency,
    sourceDocuments: unexpectedDependency,
    sourceDocumentDownloads: unexpectedDependency,
    close: async () => undefined
  };
}

function createApp(dependencies: ApiServerContext): FastifyInstance {
  const app = Fastify({ logger: false });
  registerStructuredQueryRoutes(app, {
    auth: createRequestAuth(dependencies),
    structuredQueries: dependencies.structuredQueries,
    structuredCoverage: dependencies.structuredCoverage,
    structuredPartitions: dependencies.structuredPartitions,
    cursorSigningSecret: dependencies.cursorSigningSecret
  });
  return app;
}

describe("structured query routes", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("serves dataset registry metadata only after authentication", async () => {
    const dependencies = context({ execute: async () => ({ rows: [], hasMore: false }) });
    app = createApp(dependencies);

    const missing = await app.inject({ method: "GET", url: "/v1/structured/datasets" });
    const present = await app.inject({
      method: "GET",
      url: "/v1/structured/datasets",
      headers: { authorization: "Bearer valid" }
    });

    expect(missing.statusCode).toBe(401);
    expect(present.statusCode).toBe(200);
    expect(present.json()).toMatchObject({
      limits: expect.any(Object),
      datasets: expect.arrayContaining([expect.objectContaining({ dataset: "vip" })])
    });
    expect(present.json().datasets.every((dataset: object) => "fields" in dataset)).toBe(true);
    const ledger = present
      .json()
      .datasets.find((dataset: { dataset: string }) => dataset.dataset === "delivery_ledger");
    expect(ledger).toBeUndefined();
  });

  it("executes compiled structured queries and preserves Phase 3 error envelopes", async () => {
    const repository: StructuredQueryRepository = {
      async execute() {
        return {
          rows: [
            {
              business_date: "2026-07-01",
              member_id: "肉夹馍",
              member_phone: "12"
            }
          ],
          hasMore: false
        };
      }
    };
    const dependencies = context(repository);
    app = createApp(dependencies);

    const ok = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: { authorization: "Bearer valid" },
      payload: {
        dataset: "vip",
        select: ["business_date", "member_id", "member_phone"],
        filter: { field: "member_id", op: "contains", value: "肉夹馍" },
        page: { limit: 1 }
      }
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: { authorization: "Bearer valid", "x-request-id": "req_structured" },
      payload: { dataset: "missing" }
    });

    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      dataset: "vip",
      rows: [
        {
          business_date: "2026-07-01",
          member_id: "肉夹馍",
          member_phone: "12"
        }
      ],
      nextCursor: null
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: {
        code: PHASE3_ERROR_CODES.invalidQuery,
        requestId: expect.any(String),
        retryable: false
      }
    });
  });

  it("rejects raw ledger detail and aggregates", async () => {
    const dependencies = context({ execute: async () => ({ rows: [], hasMore: false }) });
    app = createApp(dependencies);

    const detail = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: { authorization: "Bearer valid" },
      payload: {
        dataset: "delivery_ledger",
        select: ["item_name", "purchase_date"],
        page: { limit: 1 }
      }
    });
    const aggregate = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: { authorization: "Bearer valid" },
      payload: {
        dataset: "delivery_ledger",
        groupBy: ["supplier_name"],
        aggregates: [{ op: "count", as: "rows" }],
        page: { limit: 1 }
      }
    });

    expect(detail.statusCode).toBe(403);
    expect(aggregate.statusCode).toBe(403);
    expect(detail.json().error.code).toBe("LEDGER_DETAIL_DISABLED");
  });

  it("serves dataset coverage through the same authenticated structured route shell", async () => {
    const calls: unknown[] = [];
    const coverageRepository: StructuredCoverageRepository = {
      async list(compiled) {
        calls.push(compiled);
        return {
          dataset: compiled.dataset,
          metadataPolicy: "window",
          sources: [
            {
              importBatchId: "batch_1",
              sourceDocumentId: "doc_1",
              sourceDocumentTitle: "Dishes July",
              appliedAt: "2026-08-01T03:04:05.000Z",
              rowCount: 42,
              startDate: "2026-07-01",
              endDate: "2026-07-31"
            }
          ]
        };
      }
    };
    const dependencies = context(
      { execute: async () => ({ rows: [], hasMore: false }) },
      coverageRepository
    );
    app = createApp(dependencies);

    const missing = await app.inject({
      method: "GET",
      url: "/v1/structured/datasets/vip/coverage"
    });
    const ok = await app.inject({
      method: "GET",
      url: "/v1/structured/datasets/vip/coverage",
      headers: { authorization: "Bearer valid" }
    });
    const invalid = await app.inject({
      method: "GET",
      url: "/v1/structured/datasets/missing/coverage",
      headers: { authorization: "Bearer valid", "x-request-id": "req_coverage" }
    });

    expect(missing.statusCode).toBe(401);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      dataset: "vip",
      metadataPolicy: "window",
      sources: [
        {
          importBatchId: "batch_1",
          sourceDocumentId: "doc_1",
          sourceDocumentTitle: "Dishes July",
          appliedAt: "2026-08-01T03:04:05.000Z",
          rowCount: 42,
          startDate: "2026-07-01",
          endDate: "2026-07-31"
        }
      ]
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      authorizationScope: {
        orgId: "default-org",
        employee: {
          id: employee.id,
          clearance: employee.clearance
        }
      }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: {
        code: PHASE3_ERROR_CODES.invalidQuery,
        requestId: expect.any(String)
      }
    });
  });

  it("serves business/dishes coverage from authorized partition metadata", async () => {
    const dependencies = context({ execute: async () => ({ rows: [], hasMore: false }) });
    dependencies.structuredPartitions = () =>
      ({
        listCoverage: async (input: { orgId: string; clearance: number }) => {
          expect(input).toMatchObject({
            orgId: "default-org",
            clearance: 3,
            enterpriseKey: "synthetic",
            storeNameContains: ["麦家小馆", "A%_\\"]
          });
          return {
            dataset: "dishes" as const,
            enterprises: [
              {
                enterpriseKey: "synthetic",
                enterpriseName: "Synthetic",
                startDate: new Date("2026-09-07T00:00:00.000Z"),
                endDate: new Date("2026-09-13T00:00:00.000Z"),
                partitionCount: 14,
                totalRowCount: 1234n,
                stores: [{ storeId: "001", storeName: "Store A" }]
              }
            ]
          };
        }
      }) as never;
    app = createApp(dependencies);
    const response = await app.inject({
      method: "GET",
      url:
        "/v1/structured/datasets/dishes/coverage?" +
        new URLSearchParams({
          enterpriseName: "Synthetic",
          storeNameContains: JSON.stringify([" 麦家小馆 ", "A%_\\"])
        }),
      headers: { authorization: "Bearer valid" }
    });
    expect(response.json()).toEqual({
      dataset: "dishes",
      accessMode: "partition_extract",
      enterprises: [
        {
          enterpriseName: "Synthetic",
          startDate: "2026-09-07",
          endDate: "2026-09-13",
          partitionCount: 14,
          totalRowCount: 1234,
          stores: [{ storeId: "001", storeName: "Store A" }]
        }
      ]
    });
  });
});

it.each(["[]", '[" "]', "bad-json", '"store"'])(
  "rejects invalid coverage scope %s",
  async (scope) => {
    const dependencies = context({ execute: async () => ({ rows: [], hasMore: false }) });
    const scopeApp = createApp(dependencies);
    const response = await scopeApp.inject({
      method: "GET",
      url:
        "/v1/structured/datasets/business/coverage?" +
        new URLSearchParams({ storeNameContains: scope }),
      headers: { authorization: "Bearer valid" }
    });
    expect(response.statusCode).toBe(400);
    await scopeApp.close();
  }
);

it("rejects partition-only scope on row-query coverage", async () => {
  const dependencies = context({ execute: async () => ({ rows: [], hasMore: false }) });
  const scopeApp = createApp(dependencies);
  try {
    const response = await scopeApp.inject({
      method: "GET",
      url:
        "/v1/structured/datasets/vip/coverage?" +
        new URLSearchParams({
          enterpriseName: "Synthetic",
          storeNameContains: JSON.stringify(["麦家小馆"])
        }),
      headers: { authorization: "Bearer valid" }
    });
    expect(response.statusCode).toBe(400);
  } finally {
    await scopeApp.close();
  }
});

it("uses current granted category rules and rejects cursors after authorization changes", async () => {
  let version = "1";
  const compiledQueries: Parameters<StructuredQueryRepository["execute"]>[0][] = [];
  const dependencies = context({
    execute: async (compiled) => {
      compiledQueries.push(compiled);
      return { rows: [{ member_id: "synthetic" }], hasMore: true };
    }
  });
  const service = legacyPermissionService(employee);
  service.current = async () => ({
    orgId: employee.orgId,
    employeeId: employee.id,
    role: "employee",
    disabled: false,
    clearance: 0,
    mode: "enabled",
    authorizationVersion: version,
    categories: [
      {
        id: "custom-vip-id",
        key: "vip",
        kind: "fixed",
        confidentialityLevel: 0,
        ownerships: ["group"],
        requiredDimensionIds: []
      }
    ],
    grants: [
      {
        id: "grant",
        orgId: employee.orgId,
        enterpriseKey: "precise-enterprise",
        categoryIds: ["custom-vip-id"],
        ownership: "group",
        dimensions: {}
      }
    ]
  });
  dependencies.permissions = () => service;
  const app = createApp(dependencies);
  try {
    const headers = { authorization: "Bearer valid" };
    const discovery = await app.inject({ method: "GET", url: "/v1/structured/datasets", headers });
    expect(
      discovery.json().datasets.map((dataset: { dataset: string }) => dataset.dataset)
    ).toEqual(["vip"]);
    const query = { dataset: "vip", select: ["member_id"], page: { limit: 1 } };
    const first = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers,
      payload: query
    });
    expect(first.statusCode).toBe(200);
    expect(compiledQueries[0]!.sql).toContain("EXISTS (SELECT 1 FROM business_resources");
    expect(compiledQueries[0]!.sql).not.toContain("d.confidentiality_level <= ?");
    expect(compiledQueries[0]!.sql).not.toContain("precise-enterprise");
    expect(compiledQueries[0]!.params).toContain("precise-enterprise");
    version = "2";
    const next = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers,
      payload: { ...query, page: { limit: 1, cursor: first.json().nextCursor } }
    });
    expect(next.json().error.code).toBe("INVALID_CURSOR");
    expect(compiledQueries).toHaveLength(1);
  } finally {
    await app.close();
  }
});
