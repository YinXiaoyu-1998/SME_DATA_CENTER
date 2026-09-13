import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { PHASE3_ERROR_CODES, type AuthenticatedEmployee } from "@enterprise-hub/domain";
import type { StructuredCoverageRepository } from "../structured-coverage.js";
import type { StructuredQueryRepository } from "../structured-query.js";
import type { ApiServerContext } from "../app-context.js";
import { createRequestAuth } from "../request-auth.js";
import { registerStructuredQueryRoutes } from "./structured-query.js";

const employee: AuthenticatedEmployee = {
  id: "emp_1",
  orgId: "default-org",
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
      dataset: "dishes",
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
      datasets: expect.arrayContaining([expect.objectContaining({ dataset: "dishes" })])
    });
    expect(present.json().datasets.every((dataset: object) => "fields" in dataset)).toBe(true);
  });

  it("executes compiled structured queries and preserves Phase 3 error envelopes", async () => {
    const repository: StructuredQueryRepository = {
      async execute() {
        return {
          rows: [
            {
              business_date: "2026-07-01",
              matched_product_name: "肉夹馍",
              dish_sales_quantity: "12"
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
      cursorSigningSecret: dependencies.cursorSigningSecret
    });

    const ok = await app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: { authorization: "Bearer valid" },
      payload: {
        dataset: "dishes",
        select: ["business_date", "matched_product_name", "dish_sales_quantity"],
        filter: { field: "matched_product_name", op: "contains", value: "肉夹馍" },
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
      dataset: "dishes",
      rows: [
        {
          business_date: "2026-07-01",
          matched_product_name: "肉夹馍",
          dish_sales_quantity: "12"
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
      cursorSigningSecret: dependencies.cursorSigningSecret
    });

    const missing = await app.inject({
      method: "GET",
      url: "/v1/structured/datasets/dishes/coverage"
    });
    const ok = await app.inject({
      method: "GET",
      url: "/v1/structured/datasets/dishes/coverage",
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
      dataset: "dishes",
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
});
