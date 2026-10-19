import path from "node:path";
import { z } from "zod";
export { FILE_UPLOAD_ADMIN_REQUIRED_CODE, FILE_UPLOAD_ADMIN_REQUIRED_MESSAGE } from "@smedc/domain";
import {
  PHASE3_RUNTIME_LIMIT_DEFAULTS,
  PUBLIC_INPUT_LIMITS,
  STRUCTURED_DATASETS,
  STRUCTURED_QUERY_LIMITS,
  getStructuredRegistry,
  COST_CARD_DIRECTORY_REGISTRY,
  PHASE3_ERROR_CODES,
  storeReviewTextFits,
  STORE_REVIEW_LIMITS,
  STORE_REVIEW_SOURCES,
  STORE_REVIEW_REPLY_STATUSES,
  parseStoreReviewBatch,
  parseStoreReviewQuery
} from "@smedc/domain";

export const MCP_UPLOAD_FILENAME_MAX_LENGTH = PUBLIC_INPUT_LIMITS.uploadFilenameChars;
export const MCP_UPLOAD_MEDIA_TYPE_MAX_LENGTH = PUBLIC_INPUT_LIMITS.uploadMediaTypeChars;
export const MCP_UPLOAD_MAX_BYTES = PHASE3_RUNTIME_LIMIT_DEFAULTS.maxUploadBytes;
export const MCP_LOCAL_FILE_PATH_MAX_LENGTH = 4096;
export const MCP_STRUCTURED_QUERY_LIMITS = STRUCTURED_QUERY_LIMITS;
export const COST_CARD_LAUNCHER_VERSION = "0.10.0";

const evidenceFileType = z.enum(["md", "txt", "docx"]).describe("Evidence file type filter.");
const structuredDataset = z
  .enum(STRUCTURED_DATASETS)
  .describe(
    "Structured dataset: dishes, business, vip, dish_catalog, delivery_ledger, supplier_catalog, cost_cards."
  );
const scalarStructuredValue = z.union([
  z.string().max(PUBLIC_INPUT_LIMITS.structuredQueryStringScalarChars),
  z.number(),
  z.boolean(),
  z.null()
]);
const confidentialityLevel = z
  .number()
  .int()
  .min(0)
  .max(3)
  .optional()
  .describe(
    "Legacy upload level from 0 through 3. After business authorization is enabled, fixed categories use the server category level; this parameter cannot override it."
  );
const permissionId = z
  .string()
  .min(1)
  .max(255)
  .refine((v) => v.trim().length > 0);
const permissionVersion = z
  .string()
  .regex(/^\d+$/)
  .describe("Current server authorizationVersion; stale writes fail without partial changes.");
const exactBusinessName = z
  .string()
  .min(1)
  .max(255)
  .refine((v) => v.trim().length > 0);
const historicalSupplementReason = z
  .string()
  .min(1)
  .max(2048)
  .refine((v) => v.trim().length > 0)
  .optional()
  .describe(
    "Explicit historical supplementation reason, when applicable; never infer missing attributes."
  );
const businessScope = z
  .object({
    enterpriseKey: permissionId,
    ownership: z.enum(["group", "store"]),
    storeName: exactBusinessName.optional(),
    dimensions: z.record(permissionId, permissionId)
  })
  .strict()
  .superRefine((scope, context) => {
    if ((scope.ownership === "store") !== (scope.storeName !== undefined))
      context.addIssue({
        code: "custom",
        message: "Store ownership requires exactly one exact storeName; group ownership has none."
      });
  });
const businessScopes = z.array(businessScope).min(1).max(1000);
const permissionSelection = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z.object({ kind: z.literal("fixed"), values: z.array(permissionId).min(1).max(10000) }).strict()
]);
const permissionGrant = z
  .object({
    id: permissionId,
    orgId: permissionId,
    enterpriseKey: permissionId,
    categoryIds: z.array(permissionId).min(1).max(1000),
    ownership: z.enum(["group", "store"]),
    stores: permissionSelection.optional(),
    dimensions: z.record(permissionId, permissionSelection)
  })
  .strict()
  .superRefine((grant, context) => {
    if ((grant.ownership === "store") !== (grant.stores !== undefined))
      context.addIssue({
        code: "custom",
        message: "Store grants require stores; group grants have none."
      });
  });

const evidenceFilterId = z.string().min(1).max(PUBLIC_INPUT_LIMITS.evidenceFilterIdChars);
const structuredFilter: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z
      .object({
        field: z.string().min(1),
        op: z.string().min(1),
        value: z.union([
          scalarStructuredValue,
          z.array(scalarStructuredValue).max(MCP_STRUCTURED_QUERY_LIMITS.maxInValues)
        ])
      })
      .strict(),
    z.object({ and: z.array(structuredFilter).min(1) }).strict(),
    z.object({ or: z.array(structuredFilter).min(1) }).strict(),
    z.object({ not: structuredFilter }).strict()
  ])
);

const basenameOnlyFilename = z
  .string()
  .min(1)
  .max(MCP_UPLOAD_FILENAME_MAX_LENGTH)
  .refine((name) => !hasAsciiControlCharacter(name), {
    message: "Filename must not contain control characters."
  })
  .refine((name) => name === name.trim(), "Filename must not have surrounding whitespace.")
  .refine((name) => name !== "." && name !== "..", "Filename must be a basename.")
  .refine((name) => !name.includes("/") && !name.includes("\\") && !name.includes(":"), {
    message: "Filename must be a basename, not a path."
  });

const canonicalBase64 = z.string().min(1).refine(isCanonicalWhitespaceFreeBase64, {
  message: "Content must be canonical whitespace-free base64."
});

const uploadMediaType = z
  .string()
  .min(1)
  .max(MCP_UPLOAD_MEDIA_TYPE_MAX_LENGTH)
  .refine((mediaType) => !hasAsciiControlCharacter(mediaType), {
    message: "Upload MIME media type must not contain control characters."
  })
  .regex(
    /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:[A-Za-z0-9!#$&^_.+-]+|"[\t !#-[\]-~]*"))*$/,
    "Upload MIME media type must use strict MIME token syntax."
  )
  .describe("Upload MIME media type.");

const uploadFileInputSchema = z
  .object({
    name: basenameOnlyFilename.describe("Basename-only upload filename."),
    mediaType: uploadMediaType,
    encoding: z.literal("base64").describe("Upload content encoding."),
    contentBase64: canonicalBase64.describe("Canonical whitespace-free base64 upload content.")
  })
  .strict();

export const localFilePath = z
  .string()
  .min(1)
  .max(MCP_LOCAL_FILE_PATH_MAX_LENGTH)
  .refine((candidate) => path.isAbsolute(candidate), {
    message: "Local upload file path must be absolute."
  })
  .describe("Absolute local filesystem path read by the launcher.");

const launcherPathUploadFileInputSchema = z
  .object({
    name: basenameOnlyFilename.describe("Basename-only upload filename."),
    mediaType: uploadMediaType,
    encoding: z.literal("path").describe("Launcher-resolved local file path encoding."),
    filePath: localFilePath
  })
  .strict();

export const launcherUploadFileInputSchema = z.union([
  uploadFileInputSchema,
  launcherPathUploadFileInputSchema
]);

export const launcherUploadFileInputShape: z.ZodRawShape = {
  name: basenameOnlyFilename,
  mediaType: uploadMediaType,
  encoding: z.enum(["base64", "path"]),
  contentBase64: canonicalBase64.optional(),
  filePath: localFilePath.optional()
};

const currentUserInputSchema = z.object({}).strict();

const listSkillsInputSchema = z
  .object({
    q: z.string().optional().describe("Optional keyword query."),
    category: z.string().min(1).optional().describe("Optional exact category filter.")
  })
  .strict();

const searchDocumentEvidenceInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(PUBLIC_INPUT_LIMITS.evidenceQueryChars)
      .describe("Evidence search query."),
    filters: z
      .object({
        fileTypes: z.array(evidenceFileType).optional().describe("Optional md/txt/docx filters."),
        documentIds: z
          .array(evidenceFilterId)
          .max(PUBLIC_INPUT_LIMITS.evidenceFilterIdsPerGroup)
          .optional()
          .describe("Optional document ids.")
      })
      .strict()
      .optional()
      .describe("Optional evidence filters delegated to the API."),
    limit: z.number().int().min(1).max(50).optional().describe("Optional 1-50 result limit."),
    cursor: z
      .string()
      .max(PUBLIC_INPUT_LIMITS.cursorChars)
      .optional()
      .describe("Optional opaque cursor from the API.")
  })
  .strict();

const listStructuredDatasetsInputSchema = z.object({}).strict();

const partitionStoreNameContainsSchema = z
  .array(
    z
      .string()
      .transform((value) => value.normalize("NFC").trim())
      .pipe(z.string().min(1).max(255))
  )
  .min(1)
  .max(20)
  .optional();

const describeStructuredDatasetCoverageInputSchema = z
  .object({
    dataset: structuredDataset,
    enterpriseName: z
      .string()
      .trim()
      .min(1)
      .max(PUBLIC_INPUT_LIMITS.enterpriseNameChars)
      .optional(),
    storeNameContains: partitionStoreNameContainsSchema
  })
  .strict()
  .superRefine((input, context) => {
    if (input.dataset === "cost_cards" && input.storeNameContains !== undefined)
      context.addIssue({
        code: "custom",
        path: ["storeNameContains"],
        message: "Cost-card coverage accepts enterprise scope only."
      });
  });

const costCardSelectionText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0);
const downloadCostCardsInputSchema = z
  .object({
    enterpriseName: costCardSelectionText(255).optional(),
    costCardIds: z.array(costCardSelectionText(32)).min(1).max(100).optional(),
    spuIds: z.array(costCardSelectionText(64)).min(1).max(100).optional(),
    skuIds: z.array(costCardSelectionText(64)).min(1).max(100).optional(),
    dishName: costCardSelectionText(512).optional(),
    dishNameContains: costCardSelectionText(512).optional(),
    specificationName: costCardSelectionText(255).optional(),
    baseCategoryName: costCardSelectionText(255).optional()
  })
  .strict();
const archiveCostCardInputSchema = z
  .object({ costCardId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/) })
  .strict();

const partitionImportStatusInputSchema = z
  .object({
    partitionImportJobId: z.string().min(1).max(64)
  })
  .strict();

const partitionDownloadRequestId = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !hasAsciiControlCharacter(value))
  .describe(
    "Prepared partition download request ID. In download_structured_partitions, provide only this field and no range selectors; the request must have succeeded."
  );
const partitionDownloadScopeShape = {
  dataset: z.enum(["business", "dishes"]),
  enterpriseName: z.string().min(1).max(PUBLIC_INPUT_LIMITS.enterpriseNameChars),
  startDate: z.string().regex(/^\d{8}$/),
  endDate: z.string().regex(/^\d{8}$/),
  storeIds: z.array(z.string().min(1).max(255)).max(10_000).optional(),
  storeNameContains: partitionStoreNameContainsSchema
};
const preparePartitionDownloadInputSchema = z
  .object({
    ...partitionDownloadScopeShape,
    storeIds: z.array(z.string().min(1).max(255)).min(1).max(2000).optional(),
    idempotencyKey: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => value === value.trim() && value.trim().length > 0)
  })
  .strict();
const partitionDownloadStatusInputSchema = z
  .object({ requestId: partitionDownloadRequestId })
  .strict();
const downloadStructuredPartitionsInputSchema = z
  .object({
    requestId: partitionDownloadRequestId.optional(),
    dataset: partitionDownloadScopeShape.dataset.optional(),
    enterpriseName: partitionDownloadScopeShape.enterpriseName.optional(),
    startDate: partitionDownloadScopeShape.startDate.optional(),
    endDate: partitionDownloadScopeShape.endDate.optional(),
    storeIds: partitionDownloadScopeShape.storeIds,
    storeNameContains: partitionDownloadScopeShape.storeNameContains
  })
  .strict()
  .superRefine((input, context) => {
    if (input.requestId !== undefined) {
      if (Object.keys(input).some((key) => key !== "requestId"))
        context.addIssue({
          code: "custom",
          message: "requestId cannot be combined with range selectors."
        });
    } else if (!input.dataset || !input.enterpriseName || !input.startDate || !input.endDate) {
      context.addIssue({
        code: "custom",
        message: "Provide requestId or a complete dataset, enterpriseName and date range."
      });
    }
  })
  .describe(
    "Provide either only requestId for a completed ZIP, or dataset, enterpriseName and a complete YYYYMMDD date range with optional store filters. These selectors are mutually exclusive."
  );

const aggregateAlias = z.string().min(1);
const countAggregateInputSchema = z
  .object({
    op: z.literal("count"),
    field: z.string().min(1).optional(),
    as: aggregateAlias.optional()
  })
  .strict();
const fieldAggregateInputSchema = z
  .object({
    op: z.enum(["countDistinct", "sum", "avg", "min", "max"]),
    field: z.string().min(1),
    as: aggregateAlias.optional()
  })
  .strict();
const weightedAverageAggregateInputSchema = z
  .object({
    op: z.literal("weightedAvg"),
    field: z.string().min(1),
    weightField: z.string().min(1),
    as: aggregateAlias.optional()
  })
  .strict();
const structuredAggregateInputSchema = z.discriminatedUnion("op", [
  countAggregateInputSchema,
  fieldAggregateInputSchema,
  weightedAverageAggregateInputSchema
]);

const queryStructuredDatasetInputSchema = z
  .object({
    dataset: structuredDataset,
    select: z
      .array(z.string().min(1))
      .max(MCP_STRUCTURED_QUERY_LIMITS.maxSelectedFields)
      .optional()
      .describe("Optional selected field names."),
    filter: structuredFilter.optional().describe("Optional controlled filter tree."),
    sort: z
      .array(
        z
          .object({
            field: z.string().min(1),
            direction: z.enum(["asc", "desc"]).default("asc")
          })
          .strict()
      )
      .max(MCP_STRUCTURED_QUERY_LIMITS.maxSortFields)
      .optional()
      .describe("Optional controlled sort fields."),
    page: z
      .object({
        limit: z.number().int().min(1).max(MCP_STRUCTURED_QUERY_LIMITS.maxRows).optional(),
        cursor: z.string().max(PUBLIC_INPUT_LIMITS.cursorChars).nullable().optional()
      })
      .strict()
      .optional()
      .describe("Optional page limit and cursor."),
    groupBy: z
      .array(z.string().min(1))
      .max(MCP_STRUCTURED_QUERY_LIMITS.maxGroupByFields)
      .optional()
      .describe("Optional aggregate group-by field."),
    aggregates: z
      .array(structuredAggregateInputSchema)
      .max(MCP_STRUCTURED_QUERY_LIMITS.maxAggregates)
      .optional()
      .describe("Optional explicit mechanical aggregations.")
  })
  .strict()
  .superRefine(validateStructuredQueryBounds);

const uploadStructuredDatasetInputSchema = z
  .object({
    file: uploadFileInputSchema,
    dataset: structuredDataset,
    enterpriseName: z
      .string()
      .min(1)
      .max(PUBLIC_INPUT_LIMITS.enterpriseNameChars)
      .describe("Enterprise/source name for canonical naming."),
    startDate: z
      .string()
      .regex(/^\d{8}$/)
      .optional()
      .describe("YYYYMMDD business window start for dishes, business, or vip."),
    endDate: z
      .string()
      .regex(/^\d{8}$/)
      .optional()
      .describe("YYYYMMDD business window end for dishes, business, or vip."),
    snapshotDate: z
      .string()
      .regex(/^\d{8}$/)
      .optional()
      .describe("YYYYMMDD complete snapshot date for dish_catalog."),
    idempotencyKey: z
      .string()
      .min(1)
      .max(PUBLIC_INPUT_LIMITS.idempotencyKeyChars)
      .describe("Client-generated retry/idempotency key."),
    confidentialityLevel,
    historicalSupplementReason
  })
  .strict()
  .superRefine((input, context) => {
    if (input.dataset === "cost_cards" && input.confidentialityLevel !== undefined)
      context.addIssue({
        code: "custom",
        path: ["confidentialityLevel"],
        message: "Cost cards use the configured category level."
      });
    const metadataPolicy = getStructuredRegistry(input.dataset).metadataPolicy;

    switch (metadataPolicy) {
      case "snapshot":
        if (!input.snapshotDate) {
          context.addIssue({
            code: "custom",
            message: `${input.dataset} requires snapshotDate.`,
            path: ["snapshotDate"]
          });
        }
        for (const field of ["startDate", "endDate"] as const) {
          if (input[field] !== undefined) {
            context.addIssue({
              code: "custom",
              message: `${input.dataset} does not accept ${field}.`,
              path: [field]
            });
          }
        }
        return;
      case "window":
        if (input.snapshotDate !== undefined) {
          context.addIssue({
            code: "custom",
            message: "Window datasets do not accept snapshotDate.",
            path: ["snapshotDate"]
          });
        }
        for (const field of ["startDate", "endDate"] as const) {
          if (!input[field]) {
            context.addIssue({
              code: "custom",
              message: `${field} is required for window datasets.`,
              path: [field]
            });
          }
        }
        return;
      case "derived_receipt":
      case "none":
        for (const field of ["startDate", "endDate", "snapshotDate"] as const) {
          if (input[field] !== undefined) {
            context.addIssue({
              code: "custom",
              message: `${input.dataset} does not accept ${field}.`,
              path: [field]
            });
          }
        }
        return;
    }
  });

const uploadEvidenceDocumentInputSchema = z
  .object({
    file: uploadFileInputSchema,
    title: z
      .string()
      .min(1)
      .max(PUBLIC_INPUT_LIMITS.evidenceTitleChars)
      .describe("Evidence source title."),
    sourceSystem: z
      .string()
      .min(1)
      .max(PUBLIC_INPUT_LIMITS.sourceSystemChars)
      .optional()
      .describe("Optional source system."),
    confidentialityLevel: z
      .number()
      .int()
      .min(0)
      .max(3)
      .describe("Explicit evidence file level, 0 through 3; required."),
    categoryId: permissionId.describe("Existing evidence business category ID."),
    scopes: businessScopes.describe(
      "Complete explicit enterprise, ownership, exact store and dimension scope items."
    ),
    historicalSupplementReason
  })
  .strict();

const evidenceDocumentStatusInputSchema = z
  .object({
    documentId: z.string().min(1).describe("Evidence document id.")
  })
  .strict();

const importStatusInputSchema = z
  .object({
    importBatchId: z.string().min(1).describe("Structured import batch id.")
  })
  .strict();

const receiptId = z.string().min(1).max(255);

const uploadQuarantineCertificateInputSchema = z
  .object({
    file: uploadFileInputSchema,
    receiptId: receiptId.describe("Receipt ID linked to this certificate."),
    idempotencyKey: z
      .string()
      .min(1)
      .max(PUBLIC_INPUT_LIMITS.idempotencyKeyChars)
      .describe("Client-generated retry/idempotency key."),
    enterpriseName: z.string().min(1).max(128),
    storeName: exactBusinessName.describe("One exact store name, preserved without trimming."),
    confidentialityLevel,
    historicalSupplementReason
  })
  .strict();

const queryQuarantineCertificatesInputSchema = z
  .object({
    receiptIds: z.array(receiptId).min(1).max(100).describe("Receipt IDs to query.")
  })
  .strict();

const archiveQuarantineCertificatesInputSchema = z
  .object({
    sourceDocumentId: z.string().min(1).optional().describe("Source document ID to archive."),
    receiptId: receiptId.optional().describe("Receipt ID whose certificates should be archived.")
  })
  .strict()
  .refine((input) => Boolean(input.sourceDocumentId) !== Boolean(input.receiptId), {
    message: "Provide exactly one of sourceDocumentId or receiptId."
  });

const sourceDocumentDownloadUrlInputSchema = z
  .object({
    sourceDocumentId: z.string().min(1).describe("Source document ID to download.")
  })
  .strict();

// Keep these as object schemas: the exporter and launcher consume .shape.
const ledgerPdfDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      value >= "1000-01-01" &&
      value <= "9999-12-31" &&
      !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }, "Use a real YYYY-MM-DD calendar date.");
const ledgerPdfStoreNames = z
  .array(
    z
      .string()
      .min(1)
      .max(512)
      .refine((name) => name.trim().length > 0)
  )
  .min(1)
  .max(50)
  .describe("1-50 exact store names, preserved without trimming.");
const ledgerPdfScopeShape = {
  storeNames: ledgerPdfStoreNames,
  dates: z
    .array(ledgerPdfDate)
    .min(1)
    .max(366)
    .optional()
    .describe("1-366 explicit dates; exclusive with the date range."),
  startDate: ledgerPdfDate
    .optional()
    .describe("Inclusive range start; requires endDate and excludes dates."),
  endDate: ledgerPdfDate
    .optional()
    .describe("Inclusive range end; requires startDate and excludes dates.")
};
const ledgerPdfCursor = z
  .string()
  .min(1)
  .max(PUBLIC_INPUT_LIMITS.cursorChars)
  .optional()
  .describe("Opaque service cursor; pages contain at most 200 items.");
const ledgerPdfRequestId = z
  .string()
  .min(1)
  .max(128)
  .describe("Service-issued ledger PDF request ID.");
const ledgerPdfCoverageInputSchema = z
  .object({
    ...ledgerPdfScopeShape,
    storeNames: ledgerPdfStoreNames.optional(),
    cursor: ledgerPdfCursor
  })
  .strict()
  .superRefine(validateLedgerPdfDateSelection);
const ledgerPdfActionInputSchema = z
  .object({
    ...ledgerPdfScopeShape,
    idempotencyKey: z
      .string()
      .min(1)
      .max(PUBLIC_INPUT_LIMITS.idempotencyKeyChars)
      .describe("Client-generated retry/idempotency key.")
  })
  .strict()
  .superRefine(validateLedgerPdfDateSelection);
const ledgerPdfRequestStatusInputSchema = z
  .object({ requestId: ledgerPdfRequestId, cursor: ledgerPdfCursor })
  .strict();
const ledgerPdfDownloadUrlInputSchema = z.object({ requestId: ledgerPdfRequestId }).strict();
const ledgerPdfScopeFields: McpToolInputField[] = [
  { name: "storeNames", required: true, description: "1-50 exact store names." },
  {
    name: "dates",
    required: false,
    description: "1-366 real YYYY-MM-DD dates, exclusive with startDate/endDate."
  },
  {
    name: "startDate",
    required: false,
    description: "Inclusive YYYY-MM-DD range start, paired with endDate."
  },
  {
    name: "endDate",
    required: false,
    description: "Inclusive YYYY-MM-DD range end, at most 366 days."
  }
];
const ledgerPdfReadAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true
};
const ledgerPdfActionAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true
};

function validateLedgerPdfDateSelection(
  input: { dates?: string[]; startDate?: string; endDate?: string },
  context: z.RefinementCtx
): void {
  if (input.dates !== undefined) {
    if (input.startDate !== undefined || input.endDate !== undefined)
      context.addIssue({
        code: "custom",
        path: ["dates"],
        message: "Provide dates or startDate/endDate, never both."
      });
    return;
  }
  if (input.startDate === undefined || input.endDate === undefined) {
    context.addIssue({
      code: "custom",
      path: ["startDate"],
      message: "Provide dates or both startDate and endDate."
    });
    return;
  }
  if (
    input.startDate > input.endDate ||
    (Date.parse(input.endDate) - Date.parse(input.startDate)) / 86_400_000 + 1 > 366
  )
    context.addIssue({
      code: "custom",
      path: ["endDate"],
      message: "Date range must be ordered and contain at most 366 days."
    });
}

const storeReviewTime = z.string().max(32);
const reviewName = z
  .string()
  .min(1)
  .refine((v) => storeReviewTextFits(v, STORE_REVIEW_LIMITS.identityChars));
export const upsertStoreReviewsInputSchema = z
  .object({
    reviews: z
      .array(
        z
          .object({
            enterpriseName: z.string().min(1).max(STORE_REVIEW_LIMITS.enterpriseNameChars),
            source: z.enum(STORE_REVIEW_SOURCES),
            replyStatus: z.enum(STORE_REVIEW_REPLY_STATUSES).optional(),
            storeName: reviewName,
            reviewedAt: storeReviewTime,
            reviewerName: reviewName,
            feedbackId: reviewName.optional(),
            content: z
              .string()
              .refine((v) => storeReviewTextFits(v, STORE_REVIEW_LIMITS.textChars))
              .nullable()
              .optional(),
            // Intersect with the untouched input so Zod's record parser cannot discard
            // own "__proto__" dimensions. Intersection uses safe object spread.
            scores: z
              .intersection(z.record(z.string(), z.number().finite()), z.unknown())
              .nullable()
              .optional(),
            merchantReply: z
              .string()
              .refine((v) => storeReviewTextFits(v, STORE_REVIEW_LIMITS.textChars))
              .nullable()
              .optional()
          })
          .strict()
      )
      .min(1)
      .max(STORE_REVIEW_LIMITS.maxBatchRows)
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      parseStoreReviewBatch(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid store review batch." });
    }
  });
export const queryStoreReviewsInputSchema = z
  .object({
    enterpriseName: z.string().min(1).max(STORE_REVIEW_LIMITS.enterpriseNameChars),
    storeNames: z.array(reviewName).min(1).max(STORE_REVIEW_LIMITS.maxStoreNames).optional(),
    sources: z
      .array(z.enum(STORE_REVIEW_SOURCES))
      .min(1)
      .max(STORE_REVIEW_SOURCES.length)
      .optional(),
    reviewedAtFrom: storeReviewTime.optional(),
    reviewedAtTo: storeReviewTime.optional(),
    reviewerName: reviewName.optional(),
    feedbackId: reviewName.optional(),
    hasReply: z.boolean().optional(),
    replyStatuses: z
      .array(z.enum(STORE_REVIEW_REPLY_STATUSES))
      .min(1)
      .max(STORE_REVIEW_REPLY_STATUSES.length)
      .optional(),
    limit: z.number().int().min(1).max(STORE_REVIEW_LIMITS.maxRows).optional(),
    cursor: z.string().min(1).max(STORE_REVIEW_LIMITS.cursorChars).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      parseStoreReviewQuery(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid store review query." });
    }
  });

export const PERMISSION_MCP_INPUT_SCHEMAS = {
  get_my_permissions: z.object({}).strict(),
  list_account_permissions: z.object({}).strict(),
  get_account_permissions: z.object({ employeeId: permissionId }).strict(),
  update_account_permissions: z
    .object({
      employeeId: permissionId,
      expectedVersion: permissionVersion,
      clearance: z.number().int().min(0).max(3),
      grants: z.array(permissionGrant).max(1000)
    })
    .strict(),
  list_business_categories: z.object({}).strict(),
  create_evidence_category: z
    .object({
      id: permissionId,
      name: exactBusinessName,
      expectedVersion: permissionVersion,
      ownerships: z
        .array(z.enum(["group", "store"]))
        .min(1)
        .max(2),
      requiredDimensionIds: z.array(permissionId).max(1000),
      retired: z.boolean().optional()
    })
    .strict(),
  update_business_category: z
    .object({
      categoryId: permissionId,
      name: exactBusinessName,
      expectedVersion: permissionVersion,
      confidentialityLevel: z.number().int().min(0).max(3).optional(),
      ownerships: z
        .array(z.enum(["group", "store"]))
        .min(1)
        .max(2)
        .optional(),
      requiredDimensionIds: z.array(permissionId).max(1000).optional(),
      retired: z.boolean().optional()
    })
    .strict()
    .superRefine((v, context) => {
      if (
        v.confidentialityLevel !== undefined
          ? v.ownerships !== undefined || v.requiredDimensionIds !== undefined
          : !v.ownerships || !v.requiredDimensionIds
      )
        context.addIssue({
          code: "custom",
          message:
            "Supply only confidentialityLevel for a fixed category, or ownerships and requiredDimensionIds for evidence."
        });
    }),
  list_business_dimensions: z.object({}).strict(),
  create_business_dimension: z
    .object({
      id: permissionId,
      name: exactBusinessName,
      expectedVersion: permissionVersion,
      retired: z.boolean().optional()
    })
    .strict(),
  update_business_dimension: z
    .object({
      dimensionId: permissionId,
      name: exactBusinessName,
      expectedVersion: permissionVersion,
      retired: z.boolean().optional()
    })
    .strict(),
  create_business_dimension_value: z
    .object({
      dimensionId: permissionId,
      id: permissionId,
      name: exactBusinessName,
      expectedVersion: permissionVersion,
      retired: z.boolean().optional()
    })
    .strict(),
  update_business_dimension_value: z
    .object({
      dimensionId: permissionId,
      valueId: permissionId,
      name: exactBusinessName,
      expectedVersion: permissionVersion,
      retired: z.boolean().optional()
    })
    .strict(),
  list_business_stores: z.object({}).strict(),
  update_business_store: z
    .object({
      enterpriseKey: permissionId,
      name: exactBusinessName,
      expectedVersion: permissionVersion,
      retired: z.boolean().optional()
    })
    .strict(),
  update_evidence_document_attributes: z
    .object({
      documentId: permissionId,
      expectedVersion: permissionVersion,
      categoryId: permissionId,
      fileConfidentialityLevel: z.number().int().min(0).max(3),
      scopes: businessScopes,
      historicalSupplementReason
    })
    .strict(),
  get_evidence_document_management_status: z.object({ documentId: permissionId }).strict(),
  prepare_authorization_cutover: z.object({}).strict(),
  activate_authorization_cutover: z
    .object({ expectedVersion: permissionVersion, confirm: z.literal(true) })
    .strict(),
  suspend_authorization_reads: z
    .object({ expectedVersion: permissionVersion, confirm: z.literal(true) })
    .strict()
} as const;
export const PERMISSION_MCP_TOOL_NAMES = Object.keys(PERMISSION_MCP_INPUT_SCHEMAS) as Array<
  keyof typeof PERMISSION_MCP_INPUT_SCHEMAS
>;
const permissionReadNames = new Set([
  "get_my_permissions",
  "list_account_permissions",
  "get_account_permissions",
  "list_business_categories",
  "list_business_dimensions",
  "list_business_stores",
  "get_evidence_document_management_status",
  "prepare_authorization_cutover"
]);

export const SMEDC_MCP_TOOL_NAMES = [
  "upsert_store_reviews",
  "query_store_reviews",
  "smedc_get_current_user",
  "smedc_list_skills",
  "search_document_evidence",
  "list_structured_datasets",
  "query_structured_dataset",
  "describe_structured_dataset_coverage",
  "upload_structured_dataset",
  "upload_evidence_document",
  "upload_quarantine_certificate",
  "query_quarantine_certificates",
  "archive_quarantine_certificates",
  "get_source_document_download_url",
  "get_evidence_document_status",
  "get_import_status",
  "get_partition_import_status",
  "download_structured_partitions",
  "download_cost_cards",
  "archive_cost_card",
  "prepare_structured_partition_download",
  "get_structured_partition_download_status",
  "describe_ledger_pdf_coverage",
  "get_ledger_pdf_request_status",
  "prepare_ledger_pdf_download",
  "get_ledger_pdf_download_url",
  ...PERMISSION_MCP_TOOL_NAMES
] as const;

export type SmedcMcpToolName = (typeof SMEDC_MCP_TOOL_NAMES)[number];

export interface McpToolInputField {
  name: string;
  required: boolean;
  description: string;
}

export interface SmedcMcpToolContract {
  name: SmedcMcpToolName;
  title: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  inputShape: z.ZodRawShape;
  inputFields: McpToolInputField[];
  resultShape: string[];
  annotations?: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
}

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpJsonToolResult {
  [key: string]: unknown;
  content: McpTextContent[];
  isError: boolean;
}

export interface McpErrorBody {
  error: {
    code: McpErrorCode | string;
    message: string;
    retryable: boolean;
    requestId?: string;
    details?: unknown;
  };
}

export const MCP_ERROR_CODES = [
  "SMEDC_API_ERROR",
  "MCP_INPUT_VALIDATION_ERROR",
  "MCP_TOOL_NOT_FOUND",
  "MCP_UNAUTHORIZED",
  "MCP_FORBIDDEN",
  "MCP_NOT_FOUND",
  "MCP_INTERNAL_ERROR",
  "MCP_UPLOAD_FILE_INVALID"
] as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

export const SMEDC_MCP_TOOL_CONTRACTS = [
  defineToolContract({
    name: "smedc_get_current_user",
    title: "Get current SMEDC user",
    description:
      "Return the display name, email, role, clearance, and organization name of the employee authenticated for this SMEDC MCP request.",
    inputSchema: currentUserInputSchema,
    inputFields: [],
    resultShape: ["user: { displayName, email, role, clearance, organizationName }"]
  }),
  defineToolContract({
    name: "smedc_list_skills",
    title: "List SMEDC skills",
    description: "List approved Skill Directory entries by calling authenticated GET /skills.",
    inputSchema: listSkillsInputSchema,
    inputFields: [
      { name: "q", required: false, description: "Keyword query." },
      { name: "category", required: false, description: "Exact category filter." }
    ],
    resultShape: ["skills[]: approved metadata and instructions only"]
  }),
  defineToolContract({
    name: "search_document_evidence",
    title: "Search SMEDC evidence chunks",
    description:
      "Return authorized evidence chunks by calling authenticated POST /v1/evidence/search; never generates answers.",
    inputSchema: searchDocumentEvidenceInputSchema,
    inputFields: [
      { name: "query", required: true, description: "Evidence search query." },
      { name: "filters", required: false, description: "Optional API-supported filters." },
      { name: "limit", required: false, description: "1-50 result limit." },
      { name: "cursor", required: false, description: "Opaque pagination cursor." }
    ],
    resultShape: [
      "results[]: authorized evidence chunks and source-location metadata",
      "sources[]: one automatic download status/link per distinct returned document",
      "page",
      "retrieval: config versions, rerank status, relevance policy, cutoff, and dropped count",
      "warnings"
    ]
  }),
  defineToolContract({
    name: "list_structured_datasets",
    title: "List SMEDC structured datasets",
    description:
      "Discover registry-backed structured datasets by calling authenticated GET /v1/structured/datasets. Field canonicalName values are the structured-query field names; sourceColumn and aliases are for mapping user-facing/source labels to canonicalName and for result presentation.",
    inputSchema: listStructuredDatasetsInputSchema,
    inputFields: [],
    resultShape: [
      "limits",
      "datasets[]: fields with canonicalName/sourceColumn/aliases, operators, capabilities"
    ]
  }),
  defineToolContract({
    name: "query_structured_dataset",
    title: "Query SMEDC structured dataset",
    description:
      "Execute a controlled read-only structured query by calling authenticated POST /v1/structured/query. cost_cards supports scalar directory fields only; download complete CSVs for local recipe/item/store analysis. Prices and revisions remain strings.",
    inputSchema: queryStructuredDatasetInputSchema,
    inputFields: [
      {
        name: "dataset",
        required: true,
        description:
          "`dishes`, `business`, `vip`, `dish_catalog`, `delivery_ledger`, `supplier_catalog`, or `cost_cards`."
      },
      {
        name: "select",
        required: false,
        description:
          "Selected canonicalName values only. Do not send sourceColumn or aliases directly."
      },
      {
        name: "filter",
        required: false,
        description:
          "Controlled filter tree. Field references must use canonicalName values from discovery."
      },
      {
        name: "sort",
        required: false,
        description:
          "Controlled sort fields. Field references must use canonicalName values from discovery."
      },
      { name: "page", required: false, description: "Page limit/cursor." },
      {
        name: "groupBy",
        required: false,
        description: "Aggregate group-by canonicalName values only."
      },
      {
        name: "aggregates",
        required: false,
        description:
          "Explicit mechanical aggregations. Aggregate field references must use canonicalName values from discovery."
      }
    ],
    resultShape: [
      "dataset",
      "mode",
      "rows[]",
      "nextCursor",
      "presentation?: optional profile for delivery_ledger detail responses with id, title, and ordered columns[]"
    ]
  }),
  defineToolContract({
    name: "describe_structured_dataset_coverage",
    title: "Describe SMEDC structured dataset coverage",
    description:
      "Return readable applied structured source coverage facts by calling authenticated GET /v1/structured/datasets/:dataset/coverage. This tool reports sources only; clients decide completeness and reporting sufficiency.",
    inputSchema: describeStructuredDatasetCoverageInputSchema,
    inputFields: [
      {
        name: "dataset",
        required: true,
        description:
          "`dishes`, `business`, `vip`, `dish_catalog`, `delivery_ledger`, `supplier_catalog`, or `cost_cards`."
      },
      {
        name: "enterpriseName",
        required: false,
        description: "Optional enterprise/source scope for business/dishes or cost-card coverage."
      },
      {
        name: "storeNameContains",
        required: false,
        description:
          "Optional business/dishes scope: 1–20 NFC/trim literal case-sensitive store-name substrings, OR within the array and AND with enterprise scope and authorization."
      }
    ],
    resultShape: [
      "dataset",
      "metadataPolicy",
      "sources[]: readable applied source windows or snapshots",
      "cost_cards: accessMode: catalog_query, cardCount, totalItemRowCount, sources[]: { sourceDocumentId, importBatchId, cardCount, totalItemRowCount }"
    ]
  }),
  defineToolContract({
    name: "upload_structured_dataset",
    title: "Upload SMEDC structured dataset",
    description:
      "Upload the user's original XLSX/CSV. Requires the admin role. Launcher 0.5.0+ streams business/dishes through partition upload sessions; the remaining datasets use the row-import service. cost_cards requires launcher 0.10.0+, one complete original file without dates, client-side card splitting or classification overrides. A 202 queued response requires polling the matching status tool.",
    inputSchema: uploadStructuredDatasetInputSchema,
    inputFields: Object.entries(uploadStructuredDatasetInputSchema.shape).map(([name, schema]) => ({
      name,
      required: !schema.isOptional(),
      description: schema.description ?? name
    })),
    resultShape: [
      "business/dishes: partitionImportJobId, status, partitionCount, totalRowCount, error",
      "other datasets: document, processing, importBatch"
    ]
  }),
  defineToolContract({
    name: "get_partition_import_status",
    title: "Get partition import status",
    description: "Return the current status of one business/dishes partition import job.",
    inputSchema: partitionImportStatusInputSchema,
    inputFields: [
      { name: "partitionImportJobId", required: true, description: "Partition import job ID." }
    ],
    resultShape: ["partitionImportJobId", "status", "partitionCount", "totalRowCount", "error"]
  }),
  defineToolContract({
    name: "download_structured_partitions",
    title: "Download structured partitions",
    description:
      "Download authorized business/dishes daily store partitions into a launcher-managed local directory.",
    inputSchema: downloadStructuredPartitionsInputSchema,
    inputFields: [
      {
        name: "requestId",
        required: false,
        description:
          "Succeeded prepared request ID; mutually exclusive with all range selectors. Does not wait for packaging."
      },
      { name: "dataset", required: false, description: "business or dishes." },
      { name: "enterpriseName", required: false, description: "Enterprise/source name." },
      { name: "startDate", required: false, description: "Inclusive YYYYMMDD start." },
      { name: "endDate", required: false, description: "Inclusive YYYYMMDD end." },
      { name: "storeIds", required: false, description: "Optional merchant IDs." },
      {
        name: "storeNameContains",
        required: false,
        description:
          "1–20 NFC/trim store-name substrings (at most 255 characters each), literal and case-sensitive, OR within the array and AND with merchant IDs and authorization."
      }
    ],
    resultShape: ["localDirectory", "dataset", "partitionCount", "totalRowCount", "files[]"]
  }),
  defineToolContract({
    name: "download_cost_cards",
    title: "Download complete cost cards",
    description:
      "Download complete authorized cost-card CSVs into a launcher-managed local directory. Optional selectors combine with AND; array values combine with OR. Names are literal and case-sensitive; same-name specifications remain separate cards. At most one expired-link refresh restarts the whole batch. The local manifest retains each card's identity, revision and source IDs; internal URLs and CSV contents are not tool results. Requires launcher 0.10.0+, matching service support and configured tenant permissions.",
    inputSchema: downloadCostCardsInputSchema,
    inputFields: Object.keys(downloadCostCardsInputSchema.shape).map((name) => ({
      name,
      required: false,
      description: `Optional ${name} selector.`
    })),
    resultShape: [
      "localDirectory",
      "dataset: cost_cards",
      "cardCount",
      "totalItemRowCount",
      "files[]: card-ID CSV basenames; manifest.json is in localDirectory"
    ],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }),
  defineToolContract({
    name: "archive_cost_card",
    title: "Archive one cost card",
    description:
      "Archive one cost card through the current same-organization admin API. Admin status does not grant CSV read access. A new original upload may restore it; an old idempotent replay does not. Requires launcher 0.10.0+ and matching service support.",
    inputSchema: archiveCostCardInputSchema,
    inputFields: [{ name: "costCardId", required: true, description: "Exact cost card ID." }],
    resultShape: ["costCardId", "archived: true", "revision: string"],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  }),
  defineToolContract({
    name: "prepare_structured_partition_download",
    title: "Prepare structured partition download",
    description:
      "Queue an authorized business/dishes partition ZIP for a date/store scope. Reuse the same idempotencyKey for retries; poll status and download by requestId once succeeded.",
    inputSchema: preparePartitionDownloadInputSchema,
    inputFields: [
      { name: "dataset", required: true, description: "business or dishes." },
      { name: "enterpriseName", required: true, description: "Enterprise/source name." },
      { name: "startDate", required: true, description: "Inclusive YYYYMMDD start." },
      { name: "endDate", required: true, description: "Inclusive YYYYMMDD end." },
      { name: "storeIds", required: false, description: "Optional 1–2000 merchant IDs." },
      {
        name: "storeNameContains",
        required: false,
        description:
          "Optional 1–20 literal case-sensitive NFC/trim store-name substrings; OR within array, AND with other scope/authorization."
      },
      {
        name: "idempotencyKey",
        required: true,
        description: "Client retry key, at most 128 characters without surrounding whitespace."
      }
    ],
    resultShape: [
      "requestId",
      "status",
      "partitionCount",
      "totalRowCount",
      "totalByteSize",
      "retryAfterSeconds"
    ],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }),
  defineToolContract({
    name: "get_structured_partition_download_status",
    title: "Get structured partition download status",
    description:
      "Read the current authorized request status and completed partition count; pending states never include download URLs.",
    inputSchema: partitionDownloadStatusInputSchema,
    inputFields: [
      { name: "requestId", required: true, description: "Prepared partition download request ID." }
    ],
    resultShape: [
      "requestId",
      "status",
      "partitionCount",
      "completedPartitionCount",
      "totalRowCount",
      "totalByteSize",
      "retryAfterSeconds",
      "errorCode",
      "expiresAt"
    ],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }),
  defineToolContract({
    name: "upload_evidence_document",
    title: "Upload SMEDC evidence document",
    description:
      "Upload MD/TXT/DOCX evidence by calling authenticated multipart POST /v1/documents/evidence. Requires the admin role.",
    inputSchema: uploadEvidenceDocumentInputSchema,
    inputFields: Object.entries(uploadEvidenceDocumentInputSchema.shape).map(([name, schema]) => ({
      name,
      required: !schema.isOptional(),
      description: schema.description ?? name
    })),
    resultShape: ["document", "processing", "documentIndex"]
  }),
  defineToolContract({
    name: "upload_quarantine_certificate",
    title: "Upload SMEDC quarantine certificate",
    description:
      "Upload one JPG/PNG quarantine certificate linked to a receipt ID by calling authenticated multipart POST /v1/documents/quarantine-certificates. Requires the admin role.",
    inputSchema: uploadQuarantineCertificateInputSchema,
    inputFields: Object.entries(uploadQuarantineCertificateInputSchema.shape).map(
      ([name, schema]) => ({
        name,
        required: !schema.isOptional(),
        description: schema.description ?? name
      })
    ),
    resultShape: [
      "sourceDocumentId",
      "receiptId",
      "originalFileName",
      "contentType",
      "byteSize",
      "uploadedAt"
    ]
  }),
  defineToolContract({
    name: "query_quarantine_certificates",
    title: "Query SMEDC quarantine certificates",
    description:
      "Query visible quarantine certificates by receipt IDs using authenticated POST /v1/quarantine-certificates/query.",
    inputSchema: queryQuarantineCertificatesInputSchema,
    inputFields: [{ name: "receiptIds", required: true, description: "1-100 receipt IDs." }],
    resultShape: ["results[]: { receiptId, certificates[] }"]
  }),
  defineToolContract({
    name: "archive_quarantine_certificates",
    title: "Archive SMEDC quarantine certificates",
    description:
      "Privileged Administrative Operation: an admin archives one quarantine certificate by source document ID, or all certificates under one receipt ID, regardless of target confidentiality level.",
    inputSchema: archiveQuarantineCertificatesInputSchema,
    inputFields: [
      { name: "sourceDocumentId", required: false, description: "Single source document ID." },
      {
        name: "receiptId",
        required: false,
        description: "Single receipt ID for admin bulk archive."
      }
    ],
    resultShape: ["archivedCount"]
  }),
  defineToolContract({
    name: "get_source_document_download_url",
    title: "Get SMEDC source document download URL",
    description:
      "Issue an authorized temporary source-file download URL using authenticated POST /v1/source-documents/:sourceDocumentId/download-url.",
    inputSchema: sourceDocumentDownloadUrlInputSchema,
    inputFields: [{ name: "sourceDocumentId", required: true, description: "Source document ID." }],
    resultShape: [
      "sourceDocumentId",
      "downloadUrl",
      "expiresAt",
      "originalFileName",
      "contentType",
      "byteSize"
    ]
  }),
  defineToolContract({
    name: "get_evidence_document_status",
    title: "Get SMEDC evidence document status",
    description:
      "Read evidence indexing status by calling authenticated GET /v1/documents/evidence/:documentId/status.",
    inputSchema: evidenceDocumentStatusInputSchema,
    inputFields: [{ name: "documentId", required: true, description: "Evidence document id." }],
    resultShape: ["document", "processing", "documentIndex"]
  }),
  defineToolContract({
    name: "get_import_status",
    title: "Get SMEDC structured import status",
    description:
      "Read structured import status and its terminal outcome by calling authenticated GET /v1/structured/imports/:importBatchId. For cost_cards, currently authorized readers receive the exact applied importBatch.publicationSummary (counts, bounded changes and changesTruncated); upload ownership alone exposes only safe progress. Preserve the server response rather than reconstructing results from current cards.",
    inputSchema: importStatusInputSchema,
    inputFields: [
      { name: "importBatchId", required: true, description: "Structured import batch id." }
    ],
    resultShape: ["document", "processing", "importBatch"]
  }),
  defineToolContract({
    name: "describe_ledger_pdf_coverage",
    title: "Describe ledger PDF coverage",
    description:
      "Query authorized ledger PDF coverage using POST /v1/ledger-pdfs/coverage. Dates are required; stores may be omitted. Pages contain at most 200 scope facts. The service limits each scope to 5,000 actual partitions, independent of the store/date Cartesian product.",
    inputSchema: ledgerPdfCoverageInputSchema,
    inputFields: [
      ...ledgerPdfScopeFields.map((field) =>
        field.name === "storeNames" ? { ...field, required: false } : field
      ),
      { name: "cursor", required: false, description: "Opaque service pagination cursor." }
    ],
    resultShape: ["scope", "partitions[]: authorized scope coverage facts", "nextCursor"],
    annotations: ledgerPdfReadAnnotations
  }),
  defineToolContract({
    name: "get_ledger_pdf_request_status",
    title: "Get ledger PDF request status",
    description:
      "Read an authorized request using GET /v1/ledger-pdfs/requests/:requestId. Poll queued requests to a terminal status; cursor pages contain at most 200 scope facts. This tool never issues download URLs.",
    inputSchema: ledgerPdfRequestStatusInputSchema,
    inputFields: [
      { name: "requestId", required: true, description: "Service-issued ledger PDF request ID." },
      { name: "cursor", required: false, description: "Opaque service pagination cursor." }
    ],
    resultShape: [
      "requestId",
      "status",
      "partitions[]: authorized request scope facts",
      "nextCursor"
    ],
    annotations: ledgerPdfReadAnnotations
  }),
  defineToolContract({
    name: "prepare_ledger_pdf_download",
    title: "Prepare ledger PDF ZIP download",
    description:
      "Submit an idempotent ZIP request using POST /v1/ledger-pdfs/downloads for existing authorized PDFs in explicit stores/dates, at most 5,000 actual partitions. A 202 queued requestId must be polled with get_ledger_pdf_request_status. Preparation never invokes the renderer. Missing or stale PDFs must wait for the service's daily 03:00 Asia/Shanghai generation; employee agents cannot trigger generation. After ready, call get_ledger_pdf_download_url.",
    inputSchema: ledgerPdfActionInputSchema,
    inputFields: [
      ...ledgerPdfScopeFields,
      { name: "idempotencyKey", required: true, description: "Retry/idempotency key." }
    ],
    resultShape: ["requestId", "status: queued; poll get_ledger_pdf_request_status"],
    annotations: ledgerPdfActionAnnotations
  }),
  defineToolContract({
    name: "get_ledger_pdf_download_url",
    title: "Get ledger PDF ZIP download URL",
    description:
      "Get a short-lived service-signed ZIP link using POST /v1/ledger-pdfs/requests/:requestId/download-url. The service reauthorizes current access on every call. Returns a link only; no PDF base64, binary content, local file generation, or renderer invocation.",
    inputSchema: ledgerPdfDownloadUrlInputSchema,
    inputFields: [{ name: "requestId", required: true, description: "Ready ZIP request ID." }],
    resultShape: ["requestId", "downloadUrl", "expiresAt"],
    annotations: ledgerPdfReadAnnotations
  }),
  defineToolContract({
    name: "upsert_store_reviews",
    title: "Upsert store reviews",
    description:
      "Atomically record 1–1000 platform reviews using POST /v1/store-reviews/upsert. Requires the current active admin role. Every row requires an explicitly selected registered enterpriseName and exact store identity. Omitted fields remain unchanged; null clears and scores replaces the whole object. Beijing time requires at least an hour (YYYY-MM-DD HH or T with +08:00); missing minutes/seconds become zero. Only save verified published merchant replies. Optional replyStatus records one platform fact: replied, unreplied_no_content, unreplied_with_content, or needs_verification. Explicit status validates merged stored text; omitted status preserves valid state or downgrades contradictions to needs_verification. New rows default to needs_verification. Drafts and approvals are not platform facts. The batch fully commits or rolls back; repeated writes do not add duplicate rows, but counts and permission/cursor versions may change.",
    inputSchema: upsertStoreReviewsInputSchema,
    inputFields: [
      {
        name: "reviews",
        required: true,
        description: "Review rows; at most 16 MiB UTF-8 JSON per batch."
      }
    ],
    resultShape: ["received, inserted, updated, unchanged"],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  }),
  defineToolContract({
    name: "query_store_reviews",
    title: "Query store reviews",
    description:
      "Read currently authorized store reviews using POST /v1/store-reviews/query. Requires explicit enterpriseName. Administrators also require read grants. Fixed reviewedAt DESC, id DESC order; inclusive Beijing time filters. Pages may return fewer complete rows than limit to fit the MCP response byte budget; continue with nextCursor. replyStatuses filters platform facts; hasReply remains non-null/nonempty reply text presence and combines with status filters using AND. Restart pagination when data or permissions change.",
    inputSchema: queryStoreReviewsInputSchema,
    inputFields: Object.entries(queryStoreReviewsInputSchema.shape).map(([name, schema]) => ({
      name,
      required: !schema.isOptional(),
      description: name
    })),
    resultShape: [
      "rows: complete authorized review fields including replyStatus",
      "page.nextCursor"
    ],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }),
  ...PERMISSION_MCP_TOOL_NAMES.map((name) => {
    const inputSchema = PERMISSION_MCP_INPUT_SCHEMAS[name];
    return defineToolContract({
      name,
      title: name.replaceAll("_", " "),
      description:
        name === "get_my_permissions"
          ? "Read the current server permission card on every call, including complete storeReviewEnterprises.write/read lists of registered enterpriseName choices for store reviews. This is not cached by the launcher; it never grants content access by itself."
          : `${name.replaceAll("_", " ")}. Requires a current active same-organization administrator. Uses the authenticated server permission service; writes require expectedVersion. Status and configuration responses contain no download links.`,
      inputSchema,
      inputFields: Object.entries(inputSchema.shape).map(([field, schema]) => ({
        name: field,
        required: !schema.isOptional(),
        description: schema.description ?? field
      })),
      resultShape:
        name === "get_my_permissions" || name === "get_account_permissions"
          ? [
              "current server authorization snapshot: employee, version, mode, clearance, grants, category rules",
              ...(name === "get_my_permissions"
                ? [
                    "storeReviewEnterprises: { complete: true, write: [{ enterpriseKey, enterpriseName }], read: [{ enterpriseKey, enterpriseName }] }"
                  ]
                : [])
            ]
          : name === "prepare_authorization_cutover"
            ? ["authorizationVersion, ready, missing configuration and resource attributes"]
            : ["server configuration or safe management status; no content links"],
      annotations: {
        readOnlyHint: permissionReadNames.has(name),
        destructiveHint: !permissionReadNames.has(name),
        idempotentHint: permissionReadNames.has(name)
      }
    });
  })
] as const satisfies readonly SmedcMcpToolContract[];

export const mcpToolContractSchema = z
  .object({
    name: z.enum(SMEDC_MCP_TOOL_NAMES),
    title: z.string().min(1),
    description: z.string().min(1),
    inputSchema: z.custom<z.ZodObject<z.ZodRawShape>>(isZodObject),
    inputShape: z.record(z.string(), z.custom<z.ZodType>(isZodType)),
    inputFields: z.array(
      z
        .object({
          name: z.string().min(1),
          required: z.boolean(),
          description: z.string().min(1)
        })
        .strict()
    ),
    resultShape: z.array(z.string().min(1)).min(1),
    annotations: z
      .object({
        readOnlyHint: z.boolean(),
        destructiveHint: z.boolean(),
        idempotentHint: z.boolean()
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((contract, context) => {
    const shapeNames = Object.keys(contract.inputShape);
    const fieldNames = contract.inputFields.map((field) => field.name);

    if (shapeNames.join("\0") !== fieldNames.join("\0")) {
      context.addIssue({
        code: "custom",
        message: "Input fields must match input shape keys in registration order.",
        path: ["inputFields"]
      });
    }

    for (const forbiddenField of ["sessionName", "filePath"]) {
      if (forbiddenField in contract.inputShape) {
        context.addIssue({
          code: "custom",
          message: `${forbiddenField} is not part of the stateless MCP contract.`,
          path: ["inputShape", forbiddenField]
        });
      }
    }
  });

export function jsonToolResult(payload: unknown, isError = false): McpJsonToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
    isError
  };
}

export function errorToolResult(
  code: McpErrorCode | string,
  message: string,
  details?: unknown,
  options: { retryable?: boolean; requestId?: string } = {}
): McpJsonToolResult {
  const body: McpErrorBody = {
    error: {
      code,
      message,
      retryable: options.retryable ?? defaultMcpErrorRetryable(code)
    }
  };

  if (options.requestId !== undefined) {
    body.error.requestId = options.requestId;
  }

  if (details !== undefined) {
    body.error.details = details;
  }

  return jsonToolResult(body, true);
}

export function apiErrorToolResult(body: unknown): McpJsonToolResult {
  if (isApiErrorBody(body)) {
    const defaultRetryable = defaultApiErrorRetryable(body.error.code);

    return errorToolResult(body.error.code, body.error.message, undefined, {
      retryable:
        defaultRetryable && typeof body.error.retryable === "boolean"
          ? body.error.retryable
          : defaultRetryable,
      requestId: safeRequestId(body.error.requestId)
    });
  }

  return errorToolResult("SMEDC_API_ERROR", "SMEDC API request failed.", undefined, {
    retryable: true
  });
}

export function validationErrorToolResult(details: unknown): McpJsonToolResult {
  return errorToolResult("MCP_INPUT_VALIDATION_ERROR", "Invalid MCP tool input.", details);
}

export function toolNotFoundResult(toolName: string): McpJsonToolResult {
  return errorToolResult("MCP_TOOL_NOT_FOUND", `Unknown SMEDC MCP tool: ${toolName}`);
}

export function isMcpErrorBody(body: unknown): body is McpErrorBody {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return false;
  }

  const error = (body as { error: unknown }).error;

  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string" &&
    typeof (error as { retryable?: unknown }).retryable === "boolean"
  );
}

interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryable?: unknown;
    requestId?: unknown;
  };
}

function isApiErrorBody(body: unknown): body is ApiErrorBody {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return false;
  }

  const error = (body as { error: unknown }).error;

  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

function defaultMcpErrorRetryable(code: McpErrorCode | string): boolean {
  if (code === "SMEDC_API_ERROR" || code === "MCP_INTERNAL_ERROR") {
    return true;
  }

  return false;
}

function defaultApiErrorRetryable(code: string): boolean {
  if (
    code === PHASE3_ERROR_CODES.ledgerPdfNotEnabled ||
    code === PHASE3_ERROR_CODES.ledgerDetailDisabled ||
    code === PHASE3_ERROR_CODES.ledgerPdfBundleStale
  )
    return false;
  const normalized = code.toUpperCase();

  if (
    normalized.includes("VALIDATION") ||
    normalized.includes("INVALID") ||
    normalized.includes("UNAUTH") ||
    normalized.includes("AUTH") ||
    normalized.includes("BAD_REQUEST") ||
    normalized.includes("FORBIDDEN") ||
    normalized.includes("DENIED") ||
    normalized.includes("NOT_FOUND") ||
    normalized.includes("NOTFOUND") ||
    normalized.includes("CONFLICT") ||
    normalized.includes("IDEMPOTENCY") ||
    normalized.includes("ACTIVE_IMPORT_EXISTS") ||
    normalized.includes("IMPORT_IN_PROGRESS")
  ) {
    return false;
  }

  return true;
}

function validateStructuredQueryBounds(
  input: {
    dataset?: string;
    select?: string[];
    sort?: Array<{ field: string }>;
    filter?: unknown;
    page?: { limit?: number };
    groupBy?: string[];
    aggregates?: Array<{ op: string; field?: string; as?: string }>;
  },
  context: z.RefinementCtx
): void {
  if (input.dataset === "cost_cards") {
    if (input.groupBy?.length || input.aggregates?.length)
      context.addIssue({
        code: "custom",
        message: "Cost cards support directory queries only; aggregate locally after download."
      });
    const fields = new Set(COST_CARD_DIRECTORY_REGISTRY.fields.map((field) => field.canonicalName));
    const checkField = (field: string) => {
      if (!fields.has(field))
        context.addIssue({
          code: "custom",
          message: "Only cost-card directory fields may be queried."
        });
    };
    input.select?.forEach(checkField);
    input.sort?.forEach((item) => checkField(item.field));
    const checkFilter = (value: unknown, depth = 1): void => {
      if (
        !value ||
        typeof value !== "object" ||
        depth > MCP_STRUCTURED_QUERY_LIMITS.maxBooleanDepth
      )
        return;
      const node = value as Record<string, unknown>;
      if (typeof node["field"] === "string") {
        checkField(node["field"]);
        const field = COST_CARD_DIRECTORY_REGISTRY.fields.find(
          (field) => field.canonicalName === node["field"]
        );
        if (
          field?.type === "decimal" &&
          (Array.isArray(node["value"]) ? node["value"] : [node["value"]]).some(
            (value: unknown) => value !== null && typeof value !== "string"
          )
        )
          context.addIssue({
            code: "custom",
            message: "Cost-card decimal filters require exact decimal strings."
          });
      }
      for (const key of ["and", "or"])
        if (Array.isArray(node[key]))
          (node[key] as unknown[]).forEach((child) => checkFilter(child, depth + 1));
      if (node["not"] !== undefined) checkFilter(node["not"], depth + 1);
    };
    checkFilter(input.filter);
  }
  const isAggregateMode = Boolean(input.groupBy?.length || input.aggregates?.length);
  const maxLimit = isAggregateMode
    ? MCP_STRUCTURED_QUERY_LIMITS.maxAggregateGroups
    : MCP_STRUCTURED_QUERY_LIMITS.maxRows;

  if (input.page?.limit !== undefined && input.page.limit > maxLimit) {
    context.addIssue({
      code: "custom",
      message: `Page limit must be no greater than ${maxLimit}.`,
      path: ["page", "limit"]
    });
  }

  if (input.filter !== undefined) {
    validateStructuredFilterBounds(input.filter, 1, context, ["filter"]);
  }

  if (input.aggregates !== undefined) {
    validateStructuredAggregateAliases(input.aggregates, input.groupBy ?? [], context);
  }
}

function validateStructuredAggregateAliases(
  aggregates: Array<{ op: string; field?: string; as?: string }>,
  reservedAliases: Iterable<string>,
  context: z.RefinementCtx
): void {
  const seen = new Set<string>();

  for (const alias of reservedAliases) {
    seen.add(alias);
  }

  aggregates.forEach((aggregate, index) => {
    const alias =
      aggregate.as ?? (aggregate.field ? `${aggregate.op}_${aggregate.field}` : "count");
    if (seen.has(alias)) {
      context.addIssue({
        code: "custom",
        message: "Aggregate aliases must be unique.",
        path: ["aggregates", index, "as"]
      });
      return;
    }
    seen.add(alias);
  });
}

function validateStructuredFilterBounds(
  filter: unknown,
  depth: number,
  context: z.RefinementCtx,
  path: Array<string | number>
): number {
  if (depth > MCP_STRUCTURED_QUERY_LIMITS.maxBooleanDepth) {
    context.addIssue({
      code: "custom",
      message: `Filter boolean depth must be no greater than ${MCP_STRUCTURED_QUERY_LIMITS.maxBooleanDepth}.`,
      path
    });
    return 0;
  }

  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
    return 0;
  }

  if ("and" in filter || "or" in filter) {
    const values = "and" in filter ? filter.and : filter.or;

    if (!Array.isArray(values)) {
      return 0;
    }

    const count = values.reduce((total, value, index) => {
      return (
        total +
        validateStructuredFilterBounds(value, depth + 1, context, [
          ...path,
          "and" in filter ? "and" : "or",
          index
        ])
      );
    }, 0);

    if (count > MCP_STRUCTURED_QUERY_LIMITS.maxConditions) {
      context.addIssue({
        code: "custom",
        message: `Filter condition count must be no greater than ${MCP_STRUCTURED_QUERY_LIMITS.maxConditions}.`,
        path
      });
    }

    return count;
  }

  if ("not" in filter) {
    return validateStructuredFilterBounds(filter.not, depth + 1, context, [...path, "not"]);
  }

  return 1;
}

function safeRequestId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return undefined;
  }

  return value;
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }

  return false;
}

function defineToolContract(
  contract: Omit<SmedcMcpToolContract, "inputShape">
): SmedcMcpToolContract {
  return {
    ...contract,
    inputShape: contract.inputSchema.shape
  };
}

function isCanonicalWhitespaceFreeBase64(value: string): boolean {
  if (/\s/.test(value) || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return false;
  }

  const firstPaddingIndex = value.indexOf("=");

  if (firstPaddingIndex !== -1 && !/^=+$/.test(value.slice(firstPaddingIndex))) {
    return false;
  }

  const unpadded = value.replace(/=+$/, "");
  const remainder = unpadded.length % 4;

  if (remainder === 1) {
    return false;
  }

  const providedPadding = value.length - unpadded.length;
  const requiredPadding = remainder === 0 ? 0 : 4 - remainder;

  if (providedPadding !== 0 && providedPadding !== requiredPadding) {
    return false;
  }

  try {
    const padded = unpadded.padEnd(unpadded.length + requiredPadding, "=");
    const canonical = Buffer.from(padded, "base64").toString("base64").replace(/=+$/, "");

    return canonical === unpadded;
  } catch {
    return false;
  }
}

function isZodObject(value: unknown): value is z.ZodObject<z.ZodRawShape> {
  return (
    isZodType(value) &&
    "_def" in value &&
    (value as { _def?: { type?: unknown } })._def?.type === "object"
  );
}

function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "safeParse" in value;
}
