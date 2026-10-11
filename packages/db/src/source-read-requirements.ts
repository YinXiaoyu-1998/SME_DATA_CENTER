import { randomUUID } from "node:crypto";
import { Prisma, type BusinessAuthorizationMode, type PrismaClient } from "@prisma/client";
import {
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
  type HistoricalSupplementIntent
} from "./business-authorization.js";

type Tx = Prisma.TransactionClient;
type Reader = Tx | PrismaClient;
const fixedOwnership: Record<
  StructuredDatasetName | "quarantine_certificate" | "ledger_pdf",
  "group" | "store"
> = {
  business: "store",
  dishes: "store",
  vip: "group",
  dish_catalog: "group",
  supplier_catalog: "group",
  delivery_ledger: "store",
  quarantine_certificate: "store",
  ledger_pdf: "store"
};
function fail(code: string): never {
  throw new ResourceAttributesError(code);
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function deriveStructuredSourceScopes(input: {
  dataset: StructuredDatasetName;
  enterpriseKey: string;
  rows: readonly { payload: Record<string, unknown> }[];
}): BusinessScopeItem[] {
  if (!input.rows.length) fail("SOURCE_HAS_NO_PARSED_ROWS");
  if (!input.enterpriseKey) fail("RESOURCE_ATTRIBUTES_NOT_READY");
  const ownership = fixedOwnership[input.dataset];
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
    (category.kind === "fixed" && !isBusinessClearance(category.confidentialityLevel))
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
  key: keyof typeof fixedOwnership,
  mode: BusinessAuthorizationMode
) {
  let category = await tx.businessCategory.findUnique({
    where: { orgId_key: { orgId, key } },
    include: { dimensions: true }
  });
  if (!category && mode !== "enabled" && mode !== "suspended") {
    // A trusted parser registration is not an authorization grant or an invented confidentiality level.
    category = await tx.businessCategory.create({
      data: {
        orgId,
        id: `fixed:${key}`,
        key,
        name: key,
        kind: "fixed",
        confidentialityLevel: null,
        allowGroup: fixedOwnership[key] === "group",
        allowStore: fixedOwnership[key] === "store"
      },
      include: { dimensions: true }
    });
  }
  const rule: BusinessCategoryRule | null = category
    ? {
        id: category.id,
        kind: category.kind,
        confidentialityLevel: category.confidentialityLevel,
        ownerships: [fixedOwnership[key]],
        requiredDimensionIds: category.dimensions.map((d) => d.dimensionId)
      }
    : null;
  return { category, rule };
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
    dataset: StructuredDatasetName;
    rows: readonly { payload: Record<string, unknown> }[];
    enterpriseKey?: string;
    workerId: string;
  }
) {
  const state = await lockAuthorizationPublication(tx, input.orgId);
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
  const { category, rule } = await fixedCategory(tx, input.orgId, input.dataset, state.mode);
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
  requirePublicationAttributes(state.mode, rule, scopes, undefined, !!historicalSupplement);
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
  if (
    !category ||
    !rule ||
    !scopes.length ||
    scopes.some((scope) => !validateBusinessScope(scope, rule))
  ) {
    if (category)
      await requireCurrentDirectoryEligibility(tx, {
        orgId: input.orgId,
        categoryId: category.id,
        scopes,
        targetId: input.sourceDocumentId,
        historicalSupplement,
        businessDates
      });
    return;
  }
  if (input.dataset === "delivery_ledger")
    await validateReceiptPhotoStore(
      tx,
      input.orgId,
      input.rows,
      scopes[0]!,
      state.mode === "enabled"
    );
  await registerStores(tx, input.orgId, scopes);
  const resourceKey = `${input.sourceDocumentId}:${category.id}`;
  const existing = await tx.businessResource.findUnique({
    where: { orgId_kind_resourceKey: { orgId: input.orgId, kind: "source_fragment", resourceKey } }
  });
  const requirement: ResourceReadRequirement = {
    orgId: input.orgId,
    categoryId: category.id,
    valid: true,
    scopes
  };
  const result = await persistResourceAttributes(
    tx,
    {
      ...requirement,
      id: existing?.id ?? randomUUID().replaceAll("-", ""),
      kind: "source_fragment",
      resourceKey,
      sourceDocumentId: input.sourceDocumentId
    },
    { publication: true, historicalSupplement, businessDates }
  );
  await auditPublication(tx, input.orgId, result.after.id, input.workerId, requirement);
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
  const { category, rule } = await fixedCategory(tx, input.orgId, input.dataset, state.mode);
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
  requirePublicationAttributes(state.mode, rule, scopes, undefined, !!input.historicalSupplement);
  if (
    !category ||
    !rule ||
    !scopes.length ||
    scopes.some((scope) => !validateBusinessScope(scope, rule))
  ) {
    if (category)
      await requireCurrentDirectoryEligibility(tx, {
        orgId: input.orgId,
        categoryId: category.id,
        scopes,
        targetId: input.partitionId,
        historicalSupplement: input.historicalSupplement,
        businessDates: input.businessDate ? [input.businessDate] : []
      });
    return;
  }
  await registerStores(tx, input.orgId, scopes);
  const resourceKey = `partition:${input.partitionId}`;
  const existing = await tx.businessResource.findUnique({
    where: { orgId_kind_resourceKey: { orgId: input.orgId, kind: "structured", resourceKey } }
  });
  const requirement: ResourceReadRequirement = {
    orgId: input.orgId,
    categoryId: category.id,
    valid: true,
    scopes
  };
  const result = await persistResourceAttributes(
    tx,
    {
      ...requirement,
      id: existing?.id ?? randomUUID().replaceAll("-", ""),
      kind: "structured",
      resourceKey
    },
    {
      publication: true,
      historicalSupplement: input.historicalSupplement,
      businessDates: input.businessDate ? [input.businessDate] : []
    }
  );
  await auditPublication(tx, input.orgId, result.after.id, input.workerId, requirement);
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
  const rule: BusinessCategoryRule = {
    id: category.id,
    kind: "evidence",
    confidentialityLevel: null,
    ownerships: [
      ...(category.allowGroup ? ["group" as const] : []),
      ...(category.allowStore ? ["store" as const] : [])
    ],
    requiredDimensionIds: category.dimensions.map((d) => d.dimensionId)
  };
  if (
    !input.scopes.length ||
    !isBusinessClearance(input.fileConfidentialityLevel) ||
    input.scopes.some((scope) => !validateBusinessScope(scope, rule))
  )
    fail("RESOURCE_ATTRIBUTES_NOT_READY");
  await registerStores(tx, input.orgId, input.scopes);
  const existing = await tx.businessResource.findUnique({
    where: {
      orgId_kind_resourceKey: {
        orgId: input.orgId,
        kind: "evidence",
        resourceKey: input.documentId
      }
    }
  });
  return persistResourceAttributes(
    tx,
    {
      ...input,
      id: existing?.id ?? randomUUID().replaceAll("-", ""),
      kind: "evidence",
      resourceKey: input.documentId,
      categoryId: input.categoryId,
      scopes: input.scopes
    },
    { publication: true, historicalSupplement: input.historicalSupplement }
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
  const rule: BusinessCategoryRule = {
    id: resource.categoryId,
    kind: resource.category.kind,
    confidentialityLevel: resource.category.confidentialityLevel,
    ownerships: [
      ...(resource.category.allowGroup ? ["group" as const] : []),
      ...(resource.category.allowStore ? ["store" as const] : [])
    ],
    requiredDimensionIds: resource.category.dimensions.map((d) => d.dimensionId)
  };
  const scopes = resource.scopes.map((scope) => ({
    enterpriseKey: scope.enterpriseKey,
    ownership: scope.ownership,
    ...(scope.storeName !== null ? { storeName: scope.storeName } : {}),
    dimensions: Object.fromEntries(scope.dimensions.map((d) => [d.dimensionId, d.valueId]))
  }));
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
  const { category, rule } = await fixedCategory(
    tx,
    input.orgId,
    "quarantine_certificate",
    state.mode
  );
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
  requirePublicationAttributes(state.mode, rule, scopes, undefined, !!input.historicalSupplement);
  if (
    !category ||
    !rule ||
    !scopes.length ||
    scopes.some((scope) => !validateBusinessScope(scope, rule))
  ) {
    if (category)
      await requireCurrentDirectoryEligibility(tx, {
        orgId: input.orgId,
        categoryId: category.id,
        scopes,
        targetId: input.sourceDocumentId,
        historicalSupplement: input.historicalSupplement
      });
    return;
  }
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
  await registerStores(tx, input.orgId, scopes);
  return persistResourceAttributes(
    tx,
    {
      orgId: input.orgId,
      id: randomUUID().replaceAll("-", ""),
      kind: "quarantine_certificate",
      resourceKey: input.sourceDocumentId,
      documentId: input.sourceDocumentId,
      categoryId: category.id,
      valid: true,
      scopes
    },
    {
      publication: true,
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
    orgId,
    categoryId: resource.categoryId,
    valid: resource.valid && document.status === "active" && !document.archivedAt,
    scopes: resource.scopes.map((scope) => ({
      enterpriseKey: scope.enterpriseKey,
      ownership: scope.ownership,
      ...(scope.storeName !== null ? { storeName: scope.storeName } : {}),
      dimensions: Object.fromEntries(scope.dimensions.map((d) => [d.dimensionId, d.valueId]))
    }))
  }));
}
