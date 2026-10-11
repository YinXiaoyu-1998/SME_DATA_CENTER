import { compileStructuredReadScope } from "@smedc/db";
import type { FastifyInstance } from "fastify";
import {
  STRUCTURED_DATASET_REGISTRIES,
  STRUCTURED_DATASETS,
  STRUCTURED_QUERY_LIMITS,
  StructuredQueryValidationError,
  compileStructuredCoverageQuery,
  createStructuredCursor,
  compilePublicStructuredQuery,
  getPublicStructuredRegistry,
  PHASE3_ERROR_CODES,
  PartitionContractError,
  normalizeEnterpriseIdentity,
  parsePartitionStoreNameContains
} from "@smedc/domain";
import type { RequestAuth } from "../request-auth.js";
import type { StructuredCoverageRepository } from "../structured-coverage.js";
import type { StructuredQueryRepository } from "../structured-query.js";
import type { StructuredPartitionRepository } from "../structured-partitions.js";
import { phase3ErrorResponse } from "../request-errors.js";

function structuredFieldResponse(
  field: (typeof STRUCTURED_DATASET_REGISTRIES)[keyof typeof STRUCTURED_DATASET_REGISTRIES]["fields"][number],
  includeRowStorage: boolean
) {
  return {
    canonicalName: field.canonicalName,
    sourceColumn: field.sourceColumn,
    aliases: field.aliases,
    type: field.type,
    nullable: field.nullable,
    sensitivity: field.sensitivity,
    lifecycle: field.lifecycle,
    volatility: field.volatility,
    defaultReturn: field.defaultReturn,
    operators: field.operators,
    capabilities: field.capabilities,
    indexStatus: field.indexStatus,
    valueLimits: field.valueLimits,
    ...(includeRowStorage && field.storage ? { storage: field.storage } : {})
  };
}

function structuredDatasetRegistryResponse() {
  return {
    limits: STRUCTURED_QUERY_LIMITS,
    datasets: Object.values(STRUCTURED_DATASET_REGISTRIES).map((original) => {
      const registry = getPublicStructuredRegistry(original.dataset);
      return {
        dataset: registry.dataset,
        accessMode: registry.accessMode,
        ...(registry.accessMode === "row_query" ? { rowTable: registry.rowTable } : {}),
        ...(registry.queryModes
          ? { queryModes: registry.queryModes, allowedAggregates: registry.allowedAggregates }
          : {}),
        ...(registry.presentation ? { presentation: registry.presentation } : {}),
        fields: registry.fields.map((field) =>
          structuredFieldResponse(field, registry.accessMode === "row_query")
        )
      };
    })
  };
}

export function registerStructuredQueryRoutes(
  app: FastifyInstance,
  dependencies: {
    auth: RequestAuth;
    structuredQueries: () => StructuredQueryRepository;
    structuredCoverage: () => StructuredCoverageRepository;
    structuredPartitions: () => StructuredPartitionRepository;
    cursorSigningSecret: string;
    ledgerPdfDeliveryEnabled?: boolean;
  }
): void {
  app.get("/v1/structured/datasets", async (request, reply) => {
    const authenticated = await dependencies.auth.authenticate(request, reply);

    if (!authenticated) {
      return;
    }

    const snapshot = await dependencies.auth.authorization(request);
    const response = structuredDatasetRegistryResponse();
    response.datasets = response.datasets.filter(
      (dataset) =>
        dataset.dataset !== "delivery_ledger" &&
        (snapshot.mode === "legacy" ||
          snapshot.mode === "preparing" ||
          (snapshot.mode === "enabled" &&
            snapshot.categories.some(
              (category) =>
                category.key === dataset.dataset &&
                snapshot.grants.some((grant) => grant.categoryIds.includes(category.id))
            )))
    );
    return response;
  });

  app.get<{
    Params: { dataset: string };
    Querystring: { enterpriseName?: unknown; storeNameContains?: unknown };
  }>("/v1/structured/datasets/:dataset/coverage", async (request, reply) => {
    const authenticated = await dependencies.auth.authenticate(request, reply);

    if (!authenticated) {
      return;
    }

    try {
      const dataset = request.params.dataset;
      if (!STRUCTURED_DATASETS.includes(dataset as (typeof STRUCTURED_DATASETS)[number])) {
        throw new StructuredQueryValidationError(
          PHASE3_ERROR_CODES.invalidQuery,
          "Dataset is invalid.",
          { dataset }
        );
      }

      const employee = dependencies.auth.employee(request);
      const snapshot = await dependencies.auth.authorization(request);
      if (dataset === "delivery_ledger")
        throw new StructuredQueryValidationError(
          PHASE3_ERROR_CODES.ledgerDetailDisabled,
          "Ledger coverage is disabled. Use archived PDF APIs."
        );
      const registry =
        STRUCTURED_DATASET_REGISTRIES[dataset as keyof typeof STRUCTURED_DATASET_REGISTRIES];
      if (registry.accessMode === "partition_extract") {
        let enterpriseKey: string | undefined;
        if (request.query.enterpriseName !== undefined) {
          if (typeof request.query.enterpriseName !== "string") {
            throw new StructuredQueryValidationError(
              PHASE3_ERROR_CODES.invalidQuery,
              "enterpriseName must be a string."
            );
          }
          enterpriseKey = normalizeEnterpriseIdentity(request.query.enterpriseName).enterpriseKey;
        }
        let storeNameContains: string[] | undefined;
        if (request.query.storeNameContains !== undefined) {
          if (typeof request.query.storeNameContains !== "string") {
            throw new StructuredQueryValidationError(
              PHASE3_ERROR_CODES.invalidQuery,
              "storeNameContains must be one JSON-encoded array."
            );
          }
          let value: unknown;
          try {
            value = JSON.parse(request.query.storeNameContains);
          } catch {
            throw new StructuredQueryValidationError(
              PHASE3_ERROR_CODES.invalidQuery,
              "storeNameContains must be one JSON-encoded array."
            );
          }
          storeNameContains = parsePartitionStoreNameContains(value);
        }
        const coverage = await dependencies.structuredPartitions().listCoverage?.({
          orgId: employee.orgId,
          clearance: snapshot.clearance,
          authorization: snapshot,
          dataset: dataset as "business" | "dishes",
          ...(enterpriseKey !== undefined ? { enterpriseKey } : {}),
          ...(storeNameContains ? { storeNameContains } : {})
        });
        if (!coverage) throw new Error("Partition coverage repository is not configured.");
        return {
          dataset: coverage.dataset,
          accessMode: "partition_extract",
          enterprises: coverage.enterprises.map((enterprise) => ({
            enterpriseName: enterprise.enterpriseName,
            startDate: enterprise.startDate.toISOString().slice(0, 10),
            endDate: enterprise.endDate.toISOString().slice(0, 10),
            partitionCount: enterprise.partitionCount,
            totalRowCount: safeJsonInteger(enterprise.totalRowCount),
            stores: enterprise.stores
          }))
        };
      }
      if (
        request.query.enterpriseName !== undefined ||
        request.query.storeNameContains !== undefined
      ) {
        throw new StructuredQueryValidationError(
          PHASE3_ERROR_CODES.invalidQuery,
          "enterpriseName and storeNameContains coverage scope are supported only for business/dishes."
        );
      }
      const compiled = compileStructuredCoverageQuery({
        orgId: employee.orgId,
        employee: {
          id: employee.id,
          clearance: employee.clearance
        },
        dataset: dataset as (typeof STRUCTURED_DATASETS)[number],
        ...(snapshot.mode === "enabled" || snapshot.mode === "suspended"
          ? { businessAuthorization: compileStructuredReadScope(snapshot, "coverage", dataset) }
          : {})
      });

      return await dependencies.structuredCoverage().list(compiled);
    } catch (error) {
      if (error instanceof PartitionContractError) {
        return reply.code(400).send(phase3ErrorResponse(request, error.code, error.message));
      }
      if (error instanceof StructuredQueryValidationError) {
        return reply
          .code(error.code === PHASE3_ERROR_CODES.ledgerDetailDisabled ? 403 : 400)
          .send(phase3ErrorResponse(request, error.code, error.message, error.details));
      }

      throw error;
    }
  });

  app.post("/v1/structured/query", async (request, reply) => {
    const authenticated = await dependencies.auth.authenticate(request, reply);

    if (!authenticated) {
      return;
    }

    const employee = dependencies.auth.employee(request);

    try {
      const dataset = (request.body as { dataset?: string } | null)?.dataset;
      if (dataset === "delivery_ledger")
        throw new StructuredQueryValidationError(
          PHASE3_ERROR_CODES.ledgerDetailDisabled,
          "Ledger reads are disabled. Use the archived PDF APIs for ledger documents."
        );
      const snapshot = await dependencies.auth.authorization(request);
      const compiled = compilePublicStructuredQuery({
        orgId: employee.orgId,
        employee: {
          id: employee.id,
          clearance: employee.clearance
        },
        query: request.body,
        cursorSecret: dependencies.cursorSigningSecret,
        ledgerPdfDeliveryEnabled: dependencies.ledgerPdfDeliveryEnabled,
        ...(snapshot.mode === "enabled" || snapshot.mode === "suspended"
          ? {
              businessAuthorization: {
                version: snapshot.authorizationVersion,
                ...compileStructuredReadScope(snapshot, "row", dataset ?? "")
              }
            }
          : {})
      });
      const result = await dependencies.structuredQueries().execute(compiled);
      const nextCursor = result.hasMore
        ? createStructuredCursor({
            offset: compiled.offset + result.rows.length,
            shapeHash: compiled.shapeHash,
            secret: dependencies.cursorSigningSecret
          })
        : null;

      return {
        dataset: compiled.dataset,
        mode: compiled.mode,
        ...(compiled.dataset === "delivery_ledger" && compiled.mode === "detail"
          ? { presentation: STRUCTURED_DATASET_REGISTRIES.delivery_ledger.presentation }
          : {}),
        rows: result.rows,
        nextCursor
      };
    } catch (error) {
      if (error instanceof StructuredQueryValidationError) {
        const statusCode =
          error.code === PHASE3_ERROR_CODES.datasetForbidden ||
          error.code === PHASE3_ERROR_CODES.ledgerDetailDisabled
            ? 403
            : error.code === PHASE3_ERROR_CODES.cursorExpired ||
                error.code === PHASE3_ERROR_CODES.invalidCursor
              ? 400
              : 400;

        return reply
          .code(statusCode)
          .send(phase3ErrorResponse(request, error.code, error.message, error.details));
      }

      throw error;
    }
  });
}

function safeJsonInteger(value: bigint): number | string {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}
