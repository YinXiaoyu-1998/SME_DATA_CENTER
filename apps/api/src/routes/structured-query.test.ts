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
    environment: {},
    delegationProof: "proof",
    runtimeLimits: {} as ApiServerContext["runtimeLimits"],
    cursorSigningSecret: "cursor-secret",
    readinessCheck: async () => ({ ok: true, checks: [] }) as never,
    authCore: undefined,
    authenticateOfficialAccessToken: async (token) => (token === "valid" ? employee : null),
    authenticationClientSource: () => "http_api",
    createBusinessRequestAudit: () => {
      throw new Error("not used");
    },
    documents: () => {
      throw new Error("not used");
    },
    storage: () => {
      throw new Error("not used");
    },
    structuredImports: () => {
      throw new Error("not used");
    },
    structuredPartitions: () => {
      throw new Error("not used");
    },
    structuredQueries: () => repository,
    structuredCoverage: () => coverageRepository,
    skills: () => {
      throw new Error("not used");
    },
    evidence: () => {
      throw new Error("not used");
    },
    quarantineCertificates: () => {
      throw new Error("not used");
    },
    sourceDocuments: () => {
      throw new Error("not used");
    },
    sourceDocumentDownloads: () => {
      throw new Error("not used");
    },
    close: async () => undefined
  };
}

describe("structured query routes", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("serves dataset registry metadata only after authentication", async () => {
    const dependencies = context({ execute: async () => ({ rows: [], hasMore: false }) });
    app = Fastify({ logger: false });
    registerStructuredQueryRoutes(app, {
      auth: createRequestAuth(dependencies),
      structuredQueries: dependencies.structuredQueries,
      structuredCoverage: dependencies.structuredCoverage,
      structuredPartitions: dependencies.structuredPartitions,
      cursorSigningSecret: dependencies.cursorSigningSecret
    });

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
    expect(ledger?.presentation).toEqual({
      id: "food-purchase-ledger-cn-v2",
      title: "食品经营单位进货台帐",
      columns: [
        { canonicalName: "receipt_id", displayName: "收货单号" },
        { canonicalName: "item_name", displayName: "食品名称" },
        { canonicalName: "specification", displayName: "规格" },
        { canonicalName: "purchase_quantity", displayName: "进货数量" },
        { canonicalName: "purchase_amount", displayName: "进货金额" },
        { canonicalName: "production_date_or_batch", displayName: "生产日期或生产批号" },
        { canonicalName: "shelf_life", displayName: "保质期" },
        { canonicalName: "supplier_name", displayName: "供货单位名称" },
        { canonicalName: "supplier_unit_address", displayName: "供货单位地址" },
        { canonicalName: "supplier_contact_phone", displayName: "供货单位联系方式" },
        { canonicalName: "purchase_date", displayName: "进货日期" }
      ]
    });
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
    app = Fastify({ logger: false });
    registerStructuredQueryRoutes(app, {
      auth: createRequestAuth(dependencies),
      structuredQueries: dependencies.structuredQueries,
      structuredCoverage: dependencies.structuredCoverage,
      structuredPartitions: dependencies.structuredPartitions,
      cursorSigningSecret: dependencies.cursorSigningSecret
    });

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

  it("returns the ledger presentation profile for delivery-ledger detail queries only", async () => {
    const dependencies = context({ execute: async () => ({ rows: [], hasMore: false }) });
    app = Fastify({ logger: false });
    registerStructuredQueryRoutes(app, {
      auth: createRequestAuth(dependencies),
      structuredQueries: dependencies.structuredQueries,
      structuredCoverage: dependencies.structuredCoverage,
      structuredPartitions: dependencies.structuredPartitions,
      cursorSigningSecret: dependencies.cursorSigningSecret
    });

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

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      dataset: "delivery_ledger",
      mode: "detail",
      presentation: {
        id: "food-purchase-ledger-cn-v2",
        title: "食品经营单位进货台帐"
      }
    });
    expect(detail.json().presentation.columns).toEqual([
      { canonicalName: "receipt_id", displayName: "收货单号" },
      { canonicalName: "item_name", displayName: "食品名称" },
      { canonicalName: "specification", displayName: "规格" },
      { canonicalName: "purchase_quantity", displayName: "进货数量" },
      { canonicalName: "purchase_amount", displayName: "进货金额" },
      { canonicalName: "production_date_or_batch", displayName: "生产日期或生产批号" },
      { canonicalName: "shelf_life", displayName: "保质期" },
      { canonicalName: "supplier_name", displayName: "供货单位名称" },
      { canonicalName: "supplier_unit_address", displayName: "供货单位地址" },
      { canonicalName: "supplier_contact_phone", displayName: "供货单位联系方式" },
      { canonicalName: "purchase_date", displayName: "进货日期" }
    ]);
    expect(aggregate.statusCode).toBe(200);
    expect(aggregate.json()).not.toHaveProperty("presentation");
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
    app = Fastify({ logger: false });
    registerStructuredQueryRoutes(app, {
      auth: createRequestAuth(dependencies),
      structuredQueries: dependencies.structuredQueries,
      structuredCoverage: dependencies.structuredCoverage,
      structuredPartitions: dependencies.structuredPartitions,
      cursorSigningSecret: dependencies.cursorSigningSecret
    });

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
          expect(input).toMatchObject({ orgId: "default-org", clearance: 3 });
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
    app = Fastify({ logger: false });
    registerStructuredQueryRoutes(app, {
      auth: createRequestAuth(dependencies),
      structuredQueries: dependencies.structuredQueries,
      structuredCoverage: dependencies.structuredCoverage,
      structuredPartitions: dependencies.structuredPartitions,
      cursorSigningSecret: dependencies.cursorSigningSecret
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/structured/datasets/dishes/coverage",
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
