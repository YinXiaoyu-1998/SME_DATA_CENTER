import { randomUUID } from "node:crypto";
import { Prisma, type BusinessAuthorizationMode, type PrismaClient } from "@prisma/client";
import {
  FIXED_BUSINESS_CATEGORY_OWNERSHIP,
  type FixedBusinessCategoryKey,
  isBusinessClearance,
  validateBusinessScope,
  type BusinessCategoryRule,
  type BusinessScopeItem,
  type ResourceReadRequirement,
  type StructuredDatasetName
} from "@smedc/domain";
import {
  persistResourceAttributes,
  ResourceAttributesError,
  requireCurrentDirectoryEligibility,
  readHistoricalSupplementIntent,
  type ResourceAuthorizationWrite,
  type HistoricalSupplementIntent
} from "./business-authorization.js";

import {
  toBusinessCategoryRule,
  toResourceReadRequirement,
  categoriesInclude
} from "./business-authorization-records.js";
import { initializeFixedBusinessCategories } from "./fixed-business-categories.js";

type Tx = Prisma.TransactionClient;
type Reader = Tx | PrismaClient;
function fail(code: string): never {
  throw new ResourceAttributesError(code);
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function deriveStructuredSourceScopes(input: {
  dataset: StructuredDatasetName | "cost_cards";
  enterpriseKey: string;
  rows: readonly { payload: Record<string, unknown> }[];
}): BusinessScopeItem[] {
  if (!input.rows.length) fail("SOURCE_HAS_NO_PARSED_ROWS");
  if (!input.enterpriseKey) fail("RESOURCE_ATTRIBUTES_NOT_READY");
  const ownership = FIXED_BUSINESS_CATEGORY_OWNERSHIP[input.dataset];
  if (!ownership) fail("RESOURCE_CATEGORY_NOT_CONFIGURED");
  if (ownership === "group")
    return [{ enterpriseKey: input.enterpriseKey, ownership, dimensions: {} }];
  const scopes = new Map<string, BusinessScopeItem>();
  for (const { payload } of input.rows) {
    const storeName = payload["store_name"];
    if (typeof storeName !== "string" || !storeName.trim()) fail("RESOURCE_ATTRIBUTES_NOT_READY");
    scopes.set(storeName, {
      enterpriseKey: input.enterpriseKey,
      ownership,
      storeName,
      dimensions: {}
    });
  }
  if (input.dataset === "delivery_ledger" && scopes.size !== 1)
    fail("RESOURCE_SINGLE_STORE_REQUIRED");
  return [...scopes.values()];
}
export function requirePublicationAttributes(
  mode: BusinessAuthorizationMode,
  category: BusinessCategoryRule | null,
  scopes: BusinessScopeItem[],
  fileLevel?: number,
  requireCompleteAttributes = false
): void {
  if (mode === "suspended") fail("AUTHORIZATION_SUSPENDED");
  if (mode !== "enabled" && !requireCompleteAttributes) return;
  if (
    !category ||
    (category.kind === "fixed" &&
      category.key !== "delivery_ledger" &&
      !isBusinessClearance(category.confidentialityLevel))
  )
    fail("RESOURCE_CATEGORY_NOT_CONFIGURED");
  if (
    !scopes.length ||
    scopes.some((scope) => !validateBusinessScope(scope, category)) ||
    (category.kind === "evidence" && !isBusinessClearance(fileLevel))
  )
    fail("RESOURCE_ATTRIBUTES_NOT_READY");
}
// Serialize publication with permission configuration and invalidate any earlier preparation result.
export async function lockAuthorizationPublication(tx: Tx, orgId: string) {
  return tx.businessAuthorizationState.upsert({
    where: { orgId },
    create: { orgId, version: 1n },
    update: { version: { increment: 1 } }
  });
}
export async function requireCurrentUploadAdmin(tx: Tx, orgId: string, employeeId: string) {
  if (
    !(await tx.employee.findFirst({
      where: { orgId, id: employeeId, disabled: false, role: "admin" },
      select: { id: true }
    }))
  )
    fail("UPLOAD_ADMIN_REQUIRED");
}
async function fixedCategory(
  tx: Tx,
  orgId: string,
  key: FixedBusinessCategoryKey,
  mode: BusinessAuthorizationMode
) {
  const where = { orgId_key: { orgId, key } };
  let category = await tx.businessCategory.findUnique({ where, include: categoriesInclude });
  if (!category && mode !== "enabled" && mode !== "suspended") {
    await initializeFixedBusinessCategories(tx, orgId);
    category = await tx.businessCategory.findUnique({ where, include: categoriesInclude });
  }
  return category;
}
// Shared fixed-category gate; even incomplete legacy publications must check retired references.
async function prepareFixedPublication(
  tx: Tx,
  input: {
    orgId: string;
    category: Awaited<ReturnType<typeof fixedCategory>>;
    mode: BusinessAuthorizationMode;
    scopes: BusinessScopeItem[];
    targetId: string;
    historicalSupplement?: HistoricalSupplementIntent;
    businessDates?: readonly string[];
  }
) {
  const rule = input.category ? toBusinessCategoryRule(input.category) : null;
  requirePublicationAttributes(
    input.mode,
    rule,
    input.scopes,
    undefined,
    !!input.historicalSupplement
  );
  if (
    !input.category ||
    !rule ||
    !input.scopes.length ||
    input.scopes.some((scope) => !validateBusinessScope(scope, rule))
  ) {
    if (input.category)
      await requireCurrentDirectoryEligibility(tx, {
        ...input,
        categoryId: input.category.id
      });
    return null;
  }
  return input.category;
}
async function persistPublishedResource(
  tx: Tx,
  input: Omit<ResourceAuthorizationWrite, "id" | "actorId" | "expectedVersion"> & { id?: string },
  options: {
    historicalSupplement?: HistoricalSupplementIntent;
    businessDates?: readonly string[];
    workerId?: string;
  } = {}
) {
  await registerStores(tx, input.orgId, input.scopes);
  const existing = input.id
    ? null
    : await tx.businessResource.findUnique({
        where: {
          orgId_kind_resourceKey: {
            orgId: input.orgId,
            kind: input.kind,
            resourceKey: input.resourceKey
          }
        }
      });
  const result = await persistResourceAttributes(
    tx,
    {
      ...input,
      id: input.id ?? existing?.id ?? randomUUID().replaceAll("-", "")
    },
    { ...options, publication: true }
  );
  if (options.workerId !== undefined)
    await auditPublication(tx, input.orgId, result.after.id, options.workerId, input);
  return result;
}
async function registerStores(tx: Tx, orgId: string, scopes: BusinessScopeItem[]) {
  for (const scope of scopes)
    if (scope.ownership === "store")
      await tx.businessStore.upsert({
        where: {
          orgId_enterpriseKey_name: {
            orgId,
            enterpriseKey: scope.enterpriseKey,
            name: scope.storeName!
          }
        },
        create: { orgId, enterpriseKey: scope.enterpriseKey, name: scope.storeName! },
        update: {}
      });
}
async function auditPublication(
  tx: Tx,
  orgId: string,
  targetId: string,
  workerId: string,
  requirement: ResourceReadRequirement
) {
  await tx.auditLog.create({
    data: {
      orgId,
      actorEmployeeId: null,
      action: "resource.authorization.published",
      targetType: "business_resource",
      targetId,
      result: "succeeded",
      clientSource: "worker",
      metadata: {
        workerId,
        categoryId: requirement.categoryId,
        scopes: requirement.scopes as unknown as Prisma.InputJsonValue
      }
    }
  });
}
function publicationBusinessDates(
  rows: readonly { payload: Record<string, unknown> }[],
  metadata: Record<string, unknown>
): string[] {
  return [
    ...new Set(
      [
        metadata["startDate"],
        metadata["endDate"],
        ...rows.flatMap(({ payload }) => [
          payload["business_date"],
          payload["snapshot_date"],
          payload["purchase_date"]
        ])
      ].filter((value): value is string => typeof value === "string" && !!value)
    )
  ];
}
export async function persistStructuredSourceReadRequirements(
  tx: Tx,
  input: {
    orgId: string;
    sourceDocumentId: string;
    dataset: StructuredDatasetName | "cost_cards";
    rows: readonly { payload: Record<string, unknown> }[];
    enterpriseKey?: string;
    workerId: string;
    authorizationState?: Awaited<ReturnType<typeof lockAuthorizationPublication>>;
  }
) {
  const state = input.authorizationState ?? (await lockAuthorizationPublication(tx, input.orgId));
  const document = await tx.document.findFirstOrThrow({
    where: {
      id: input.sourceDocumentId,
      orgId: input.orgId,
      documentKind: "structured",
      archivedAt: null,
      status: { not: "archived" }
    },
    select: { sourceMetadata: true }
  });
  const enterpriseKey = input.enterpriseKey ?? record(document.sourceMetadata)["enterpriseKey"];
  const historicalSupplement = readHistoricalSupplementIntent(
    record(document.sourceMetadata)["historicalSupplement"]
  );
  const businessDates = publicationBusinessDates(input.rows, record(document.sourceMetadata));
  let category = await fixedCategory(tx, input.orgId, input.dataset, state.mode);
  if (!input.rows.length) fail("SOURCE_HAS_NO_PARSED_ROWS");
  let scopes: BusinessScopeItem[] = [];
  try {
    scopes = deriveStructuredSourceScopes({
      dataset: input.dataset,
      enterpriseKey: typeof enterpriseKey === "string" ? enterpriseKey : "",
      rows: input.rows
    });
  } catch (error) {
    if (state.mode === "enabled" || !(error instanceof ResourceAttributesError)) throw error;
  }
  await tx.document.update({
    where: { id: input.sourceDocumentId },
    data: {
      sourceMetadata: {
        ...record(document.sourceMetadata),
        parsedBusinessScopes: {
          dataset: input.dataset,
          enterpriseKey: typeof enterpriseKey === "string" ? enterpriseKey : null,
          scopes: scopes as unknown as Prisma.InputJsonValue
        }
      } as Prisma.InputJsonValue
    }
  });
  category = await prepareFixedPublication(tx, {
    orgId: input.orgId,
    category,
    mode: state.mode,
    scopes,
    targetId: input.sourceDocumentId,
    historicalSupplement,
    businessDates
  });
  if (!category) return;
  if (input.dataset === "delivery_ledger")
    await validateReceiptPhotoStore(
      tx,
      input.orgId,
      input.rows,
      scopes[0]!,
      state.mode === "enabled"
    );
  await persistPublishedResource(
    tx,
    {
      orgId: input.orgId,
      categoryId: category.id,
      valid: true,
      scopes,
      kind: "source_fragment",
      resourceKey: `${input.sourceDocumentId}:${category.id}`,
      sourceDocumentId: input.sourceDocumentId
    },
    { historicalSupplement, businessDates, workerId: input.workerId }
  );
}

export async function persistPartitionReadRequirement(
  tx: Tx,
  input: {
    orgId: string;
    partitionId: string;
    dataset: "business" | "dishes";
    enterpriseKey: string;
    storeName: string;
    workerId: string;
    historicalSupplement?: HistoricalSupplementIntent;
    businessDate?: string;
  },
  state: Awaited<ReturnType<typeof lockAuthorizationPublication>>
) {
  let category = await fixedCategory(tx, input.orgId, input.dataset, state.mode);
  const scopes: BusinessScopeItem[] = input.storeName.trim()
    ? [
        {
          enterpriseKey: input.enterpriseKey,
          ownership: "store",
          storeName: input.storeName,
          dimensions: {}
        }
      ]
    : [];
  const businessDates = input.businessDate ? [input.businessDate] : [];
  category = await prepareFixedPublication(tx, {
    orgId: input.orgId,
    category,
    mode: state.mode,
    scopes,
    targetId: input.partitionId,
    historicalSupplement: input.historicalSupplement,
    businessDates
  });
  if (!category) return;
  await persistPublishedResource(
    tx,
    {
      orgId: input.orgId,
      categoryId: category.id,
      valid: true,
      scopes,
      kind: "structured",
      resourceKey: `partition:${input.partitionId}`
    },
    { historicalSupplement: input.historicalSupplement, businessDates, workerId: input.workerId }
  );
}

export async function persistCostCardReadRequirement(
  tx: Tx,
  input: { orgId: string; costCardId: string; enterpriseKey: string; workerId: string },
  state: Awaited<ReturnType<typeof lockAuthorizationPublication>>
) {
  if (state.mode !== "enabled") fail("AUTHORIZATION_NOT_ENABLED");
  const scopes: BusinessScopeItem[] = [
    { enterpriseKey: input.enterpriseKey, ownership: "group", dimensions: {} }
  ];
  const category = await prepareFixedPublication(tx, {
    orgId: input.orgId,
    category: await fixedCategory(tx, input.orgId, "cost_cards", state.mode),
    mode: state.mode,
    scopes,
    targetId: input.costCardId
  });
  if (!category) fail("RESOURCE_CATEGORY_NOT_CONFIGURED");
  await persistPublishedResource(
    tx,
    {
      orgId: input.orgId,
      categoryId: category.id,
      valid: true,
      scopes,
      kind: "cost_card",
      resourceKey: `cost-card:${input.costCardId}`
    },
    { workerId: input.workerId }
  );
}

export async function persistEvidenceReadRequirement(
  tx: Tx,
  input: {
    orgId: string;
    documentId: string;
    categoryId?: string;
    scopes?: BusinessScopeItem[];
    fileConfidentialityLevel: number;
    valid: boolean;
    historicalSupplement?: HistoricalSupplementIntent;
  }
) {
  const state = await lockAuthorizationPublication(tx, input.orgId);
  if (!input.categoryId || !input.scopes) {
    requirePublicationAttributes(state.mode, null, [], undefined, !!input.historicalSupplement);
    return;
  }
  const category = await tx.businessCategory.findUnique({
    where: { orgId_id: { orgId: input.orgId, id: input.categoryId } },
    include: { dimensions: true }
  });
  if (!category || category.kind !== "evidence") fail("RESOURCE_CATEGORY_NOT_CONFIGURED");
  const rule = toBusinessCategoryRule(category);
  if (
    !input.scopes.length ||
    !isBusinessClearance(input.fileConfidentialityLevel) ||
    input.scopes.some((scope) => !validateBusinessScope(scope, rule))
  )
    fail("RESOURCE_ATTRIBUTES_NOT_READY");
  return persistPublishedResource(
    tx,
    {
      ...input,
      kind: "evidence",
      resourceKey: input.documentId,
      categoryId: input.categoryId,
      scopes: input.scopes
    },
    { historicalSupplement: input.historicalSupplement }
  );
}

export async function activateEvidenceReadRequirement(tx: Tx, orgId: string, documentId: string) {
  const state = await lockAuthorizationPublication(tx, orgId);
  const resource = await tx.businessResource.findUnique({
    where: { orgId_kind_resourceKey: { orgId, kind: "evidence", resourceKey: documentId } },
    include: {
      scopes: { include: { dimensions: true } },
      category: { include: { dimensions: true } }
    }
  });
  if (!resource) {
    requirePublicationAttributes(state.mode, null, []);
    return;
  }
  const rule = toBusinessCategoryRule(resource.category);
  const { scopes } = toResourceReadRequirement(resource);
  const document = await tx.document.findFirst({
    where: {
      orgId,
      id: documentId,
      documentKind: "evidence",
      archivedAt: null,
      status: { not: "archived" }
    },
    select: { sourceMetadata: true }
  });
  if (!document) fail("RESOURCE_INVALID");
  const historicalSupplement = readHistoricalSupplementIntent(
    record(document.sourceMetadata)["historicalSupplement"]
  );
  requirePublicationAttributes(
    state.mode,
    rule,
    scopes,
    resource.fileConfidentialityLevel ?? undefined,
    !!historicalSupplement
  );
  await requireCurrentDirectoryEligibility(tx, {
    orgId,
    categoryId: resource.categoryId,
    scopes,
    targetId: resource.id,
    historicalSupplement
  });
  await tx.businessResource.update({
    where: { orgId_id: { orgId, id: resource.id } },
    data: { valid: true, authorizationVersion: { increment: 1 } }
  });
}
export async function validateReceiptPhotoStore(
  tx: Tx,
  orgId: string,
  rows: readonly { payload: Record<string, unknown> }[],
  scope: BusinessScopeItem,
  strict = false
) {
  const receiptIds = [
    ...new Set(
      rows
        .map((row) => row.payload["receipt_id"])
        .filter((id): id is string => typeof id === "string" && !!id)
    )
  ];
  const photos = await tx.quarantineCertificate.findMany({
    where: {
      orgId,
      receiptId: { in: receiptIds },
      sourceDocument: { status: "active", archivedAt: null }
    },
    include: {
      sourceDocument: {
        include: {
          businessResources: {
            where: { kind: "quarantine_certificate", valid: true },
            include: { scopes: true }
          }
        }
      }
    }
  });
  for (const photo of photos) {
    if (
      strict &&
      (!photo.sourceDocument.businessResources.length ||
        photo.sourceDocument.businessResources.some((resource) => !resource.scopes.length))
    )
      fail("RESOURCE_ATTRIBUTES_NOT_READY");
    for (const resource of photo.sourceDocument.businessResources)
      for (const photoScope of resource.scopes)
        if (
          photoScope.enterpriseKey !== scope.enterpriseKey ||
          photoScope.storeName !== scope.storeName
        )
          fail("CERTIFICATE_STORE_MISMATCH");
  }
}
export async function persistPhotoReadRequirement(
  tx: Tx,
  input: {
    orgId: string;
    sourceDocumentId: string;
    enterpriseKey?: string;
    storeName?: string;
    receiptId: string;
    historicalSupplement?: HistoricalSupplementIntent;
  }
) {
  const state = await lockAuthorizationPublication(tx, input.orgId);
  let category = await fixedCategory(tx, input.orgId, "quarantine_certificate", state.mode);
  const scopes: BusinessScopeItem[] =
    input.enterpriseKey && input.storeName?.trim()
      ? [
          {
            enterpriseKey: input.enterpriseKey,
            ownership: "store",
            storeName: input.storeName,
            dimensions: {}
          }
        ]
      : [];
  category = await prepareFixedPublication(tx, {
    orgId: input.orgId,
    category,
    mode: state.mode,
    scopes,
    targetId: input.sourceDocumentId,
    historicalSupplement: input.historicalSupplement
  });
  if (!category) return;
  const ledgerRows = await tx.deliveryLedgerRow.findMany({
    where: {
      orgId: input.orgId,
      importBatch: { status: "applied", naturalKey: input.receiptId },
      sourceDocument: { status: "active", archivedAt: null }
    },
    include: { sourceDocument: { select: { sourceMetadata: true } } }
  });
  for (const row of ledgerRows) {
    const payload = record(row.payload);
    const enterpriseKey = record(row.sourceDocument.sourceMetadata)["enterpriseKey"];
    if (state.mode === "enabled" && typeof enterpriseKey !== "string")
      fail("RESOURCE_ATTRIBUTES_NOT_READY");
    if (
      payload["store_name"] !== input.storeName ||
      (typeof enterpriseKey === "string" && enterpriseKey !== input.enterpriseKey)
    )
      fail("CERTIFICATE_STORE_MISMATCH");
  }
  return persistPublishedResource(
    tx,
    {
      // Photos are create-only; a duplicate source identity must still fail atomically.
      id: randomUUID().replaceAll("-", ""),
      orgId: input.orgId,
      kind: "quarantine_certificate",
      resourceKey: input.sourceDocumentId,
      documentId: input.sourceDocumentId,
      categoryId: category.id,
      valid: true,
      scopes
    },
    {
      historicalSupplement: input.historicalSupplement,
      businessDates: publicationBusinessDates(
        ledgerRows.map((row) => ({ payload: record(row.payload) })),
        {}
      )
    }
  );
}

export async function getSourceReadRequirements(
  reader: Reader,
  sourceDocumentId: string,
  orgId: string
): Promise<ResourceReadRequirement[]> {
  const client = reader as PrismaClient;
  if (typeof client.$transaction === "function")
    return client.$transaction((tx) => readSourceRequirements(tx, sourceDocumentId, orgId));
  return readSourceRequirements(reader, sourceDocumentId, orgId);
}
async function readSourceRequirements(
  reader: Reader,
  sourceDocumentId: string,
  orgId: string
): Promise<ResourceReadRequirement[]> {
  const document = await reader.document.findFirst({
    where: { orgId, id: sourceDocumentId, documentKind: "structured" },
    select: { status: true, archivedAt: true }
  });
  const resources = await reader.businessResource.findMany({
    where: { orgId, sourceDocumentId, kind: "source_fragment" },
    include: { scopes: { include: { dimensions: true } } }
  });
  if (!document || !resources.length || resources.some((resource) => !resource.scopes.length))
    fail("SOURCE_AUTHORIZATION_NOT_READY");
  return resources.map((resource) => ({
    ...toResourceReadRequirement(resource),
    valid: resource.valid && document.status === "active" && !document.archivedAt
  }));
}

/** Review rows are published only into an existing exact enterprise/store directory. */
export async function persistStoreReviewResource(
  tx: Tx,
  input: {
    orgId: string;
    reviewId: string;
    enterpriseKey: string;
    storeName: string;
    actorId: string;
  },
  state: Awaited<ReturnType<typeof lockAuthorizationPublication>>,
  category?: Awaited<ReturnType<typeof fixedCategory>>
) {
  if (state.mode !== "enabled") fail("AUTHORIZATION_NOT_ENABLED");
  const scopes: BusinessScopeItem[] = [
    {
      enterpriseKey: input.enterpriseKey,
      ownership: "store",
      storeName: input.storeName,
      dimensions: {}
    }
  ];
  const selected = category ?? (await fixedCategory(tx, input.orgId, "store_reviews", state.mode));
  const rule = selected ? toBusinessCategoryRule(selected) : null;
  requirePublicationAttributes(state.mode, rule, scopes);
  if (!selected || selected.key !== "store_reviews" || selected.retired)
    fail("RESOURCE_CATEGORY_NOT_CONFIGURED");
  const store = await tx.businessStore.findUnique({
    where: {
      orgId_enterpriseKey_name: {
        orgId: input.orgId,
        enterpriseKey: input.enterpriseKey,
        name: input.storeName
      }
    }
  });
  if (!store) fail("RESOURCE_ATTRIBUTES_NOT_READY");
  if (store.retired) fail("RESOURCE_DIRECTORY_RETIRED");
  const resourceKey = `store-review:${input.reviewId}`;
  const where = {
    orgId_kind_resourceKey: { orgId: input.orgId, kind: "store_review" as const, resourceKey }
  };
  const existing = await tx.businessResource.findUnique({
    where,
    include: { scopes: { include: { dimensions: true } } }
  });
  // Keep the same immutable identity, fixed category and exact single-store constraints as
  // persistResourceAttributes, without loading the already-locked category for every row.
  if (
    existing &&
    (existing.id !== input.reviewId ||
      existing.categoryId !== selected.id ||
      existing.documentId !== null ||
      existing.sourceDocumentId !== null ||
      existing.scopes.length !== 1 ||
      existing.scopes[0]!.ownership !== "store" ||
      existing.scopes[0]!.enterpriseKey !== input.enterpriseKey ||
      existing.scopes[0]!.storeName !== input.storeName ||
      existing.scopes[0]!.dimensions.length)
  )
    fail("RESOURCE_IDENTITY_IMMUTABLE");
  const resource = await tx.businessResource.upsert({
    where,
    create: {
      orgId: input.orgId,
      id: input.reviewId,
      kind: "store_review",
      resourceKey,
      categoryId: selected.id,
      valid: true
    },
    update: {
      valid: true,
      authorizationVersion: { increment: 1 },
      contentVersion: { increment: 1 }
    }
  });
  if (!existing)
    await tx.businessResourceScope.create({
      data: {
        orgId: input.orgId,
        id: randomUUID().replaceAll("-", ""),
        resourceId: resource.id,
        enterpriseKey: input.enterpriseKey,
        ownership: "store",
        storeName: input.storeName
      }
    });
  return resource;
}
