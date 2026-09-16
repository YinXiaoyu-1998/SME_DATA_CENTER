import type { FastifyInstance } from "fastify";
import {
  STRUCTURED_DATASET_REGISTRIES,
  STRUCTURED_DATASETS,
  STRUCTURED_QUERY_LIMITS,
  StructuredQueryValidationError,
  compileStructuredCoverageQuery,
  createStructuredCursor,
  compileStructuredQuery,
  PHASE3_ERROR_CODES
} from "@enterprise-hub/domain";
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
    datasets: Object.values(STRUCTURED_DATASET_REGISTRIES).map((registry) => ({
      dataset: registry.dataset,
      accessMode: registry.accessMode,
      ...(registry.accessMode === "row_query" ? { rowTable: registry.rowTable } : {}),
      ...(registry.presentation ? { presentation: registry.presentation } : {}),
      fields: registry.fields.map((field) =>
        structuredFieldResponse(field, registry.accessMode === "row_query")
      )
    }))
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
  }
): void {
  app.get("/v1/structured/datasets", async (request, reply) => {
    const authenticated = await dependencies.auth.authenticate(request, reply);

    if (!authenticated) {
      return;
    }

    return structuredDatasetRegistryResponse();
  });

  app.get<{
    Params: { dataset: string };
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
      const registry =
        STRUCTURED_DATASET_REGISTRIES[dataset as keyof typeof STRUCTURED_DATASET_REGISTRIES];
      if (registry.accessMode === "partition_extract") {
        const coverage = await dependencies.structuredPartitions().listCoverage?.({
          orgId: employee.orgId,
          clearance: employee.clearance,
          dataset: dataset as "business" | "dishes"
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
      const compiled = compileStructuredCoverageQuery({
        orgId: employee.orgId,
        employee: {
          id: employee.id,
          clearance: employee.clearance
        },
        dataset: dataset as (typeof STRUCTURED_DATASETS)[number]
      });

      return await dependencies.structuredCoverage().list(compiled);
    } catch (error) {
      if (error instanceof StructuredQueryValidationError) {
        return reply
          .code(400)
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
      const compiled = compileStructuredQuery({
        orgId: employee.orgId,
        employee: {
          id: employee.id,
          clearance: employee.clearance
        },
        query: request.body,
        cursorSecret: dependencies.cursorSigningSecret
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
          error.code === PHASE3_ERROR_CODES.datasetForbidden
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
