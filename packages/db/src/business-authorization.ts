import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Prisma, type PrismaClient, type BusinessResourceKind } from "@prisma/client";
import {
  isBusinessClearance,
  validateBusinessGrant,
  validateBusinessScope,
  type AuthorizationSnapshot,
  type BusinessCategoryRule,
  type BusinessGrant,
  type ResourceReadRequirement
} from "@smedc/domain";

export interface AuthorizationWriteContext {
  orgId: string;
  actorId: string;
  expectedVersion: string;
}
export interface CategoryWrite extends AuthorizationWriteContext, BusinessCategoryRule {
  key?: string;
  name: string;
  retired?: boolean;
  createOnly?: boolean;
}
export interface ResourceAuthorizationWrite
  extends AuthorizationWriteContext, ResourceReadRequirement {
  id: string;
  kind: BusinessResourceKind;
  resourceKey: string;
  documentId?: string;
  sourceDocumentId?: string;
  historicalSupplementReason?: string;
}
// Fixed categories are developer-registered; evidence categories cannot impersonate them.
const fixedCategoryOwnership: Record<string, "group" | "store"> = {
  business: "store",
  dishes: "store",
  vip: "group",
  dish_catalog: "group",
  supplier_catalog: "group",
  delivery_ledger: "store",
  quarantine_certificate: "store",
  ledger_pdf: "store"
};
type Tx = Prisma.TransactionClient;
const categoriesInclude = { dimensions: true } as const;
const grantsInclude = {
  categories: true,
  stores: true,
  dimensions: { include: { values: true } }
} as const;
const resourcesInclude = { scopes: { include: { dimensions: true } } } as const;
type ResourceRow = Prisma.BusinessResourceGetPayload<{ include: typeof resourcesInclude }>;
function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item
    )
  ) as Prisma.InputJsonValue;
}
function categoryRule(
  row: Prisma.BusinessCategoryGetPayload<{ include: typeof categoriesInclude }>
): BusinessCategoryRule {
  return {
    id: row.id,
    kind: row.kind,
    confidentialityLevel: row.confidentialityLevel,
    ownerships: [
      ...(row.allowGroup ? ["group" as const] : []),
      ...(row.allowStore ? ["store" as const] : [])
    ],
    requiredDimensionIds: row.dimensions.map((d) => d.dimensionId).sort()
  };
}
function resourceRequirement(row: ResourceRow): ResourceReadRequirement {
  return {
    orgId: row.orgId,
    categoryId: row.categoryId,
    valid: row.valid,
    fileConfidentialityLevel: row.fileConfidentialityLevel,
    scopes: row.scopes.map((scope) => ({
      enterpriseKey: scope.enterpriseKey,
      ownership: scope.ownership,
      ...(scope.storeName !== null ? { storeName: scope.storeName } : {}),
      dimensions: Object.fromEntries(scope.dimensions.map((d) => [d.dimensionId, d.valueId]))
    }))
  };
}
function canonicalScopes(scopes: ResourceReadRequirement["scopes"]): string[] {
  return scopes
    .map((scope) =>
      JSON.stringify([
        scope.enterpriseKey,
        scope.ownership,
        scope.storeName ?? null,
        Object.entries(scope.dimensions).sort(([a], [b]) => a.localeCompare(b))
      ])
    )
    .sort();
}
function preservesSourceTuples(
  previous: ResourceReadRequirement["scopes"],
  enriched: ResourceReadRequirement["scopes"]
): boolean {
  if (previous.length !== enriched.length) return false;
  // Match occurrences, not independent dimension sets: no tuple may disappear or be duplicated.
  const unmatched = [...enriched];
  return previous.every((scope) => {
    const index = unmatched.findIndex(
      (candidate) =>
        candidate.enterpriseKey === scope.enterpriseKey &&
        candidate.ownership === scope.ownership &&
        candidate.storeName === scope.storeName &&
        Object.entries(scope.dimensions).every(([id, value]) => candidate.dimensions[id] === value)
    );
    if (index < 0) return false;
    unmatched.splice(index, 1);
    return true;
  });
}
export async function persistBusinessGrants(
  tx: Tx,
  input: { orgId: string; employeeId: string; grants: BusinessGrant[] },
  categories: BusinessCategoryRule[]
) {
  for (const grant of input.grants) {
    if (grant.orgId !== input.orgId || validateBusinessGrant(grant, categories).length)
      throw new Error("INVALID_BUSINESS_GRANT");
  }
  await tx.businessGrant.deleteMany({
    where: { orgId: input.orgId, employeeId: input.employeeId }
  });
  for (const grant of input.grants) {
    await tx.businessGrant.create({
      data: {
        orgId: input.orgId,
        id: grant.id,
        employeeId: input.employeeId,
        enterpriseKey: grant.enterpriseKey,
        ownership: grant.ownership,
        allStores: grant.stores?.kind === "all"
      }
    });
    await tx.businessGrantCategory.createMany({
      data: grant.categoryIds.map((categoryId) => ({
        orgId: input.orgId,
        grantId: grant.id,
        categoryId
      }))
    });
    if (grant.stores?.kind === "fixed")
      await tx.businessGrantStore.createMany({
        data: grant.stores.values.map((storeName) => ({
          orgId: input.orgId,
          grantId: grant.id,
          enterpriseKey: grant.enterpriseKey,
          storeName
        }))
      });
    for (const [dimensionId, selection] of Object.entries(grant.dimensions)) {
      await tx.businessGrantDimension.create({
        data: {
          orgId: input.orgId,
          grantId: grant.id,
          dimensionId,
          allValues: selection.kind === "all"
        }
      });
      if (selection.kind === "fixed")
        await tx.businessGrantDimensionValue.createMany({
          data: selection.values.map((valueId) => ({
            orgId: input.orgId,
            grantId: grant.id,
            dimensionId,
            valueId
          }))
        });
    }
  }
}
export class ResourceAttributesError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export interface HistoricalSupplementIntent {
  actorEmployeeId: string;
  reason: string;
}
export function readHistoricalSupplementIntent(
  value: unknown
): HistoricalSupplementIntent | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("actorEmployeeId" in value) ||
    !("reason" in value) ||
    typeof value.actorEmployeeId !== "string" ||
    typeof value.reason !== "string"
  )
    throw new ResourceAttributesError("RESOURCE_HISTORICAL_INTENT_INVALID");
  return { actorEmployeeId: value.actorEmployeeId, reason: value.reason };
}
export async function bindHistoricalSupplementIntent(
  tx: Tx,
  orgId: string,
  actorEmployeeId: string,
  reason?: string,
  businessDates: readonly string[] = []
): Promise<HistoricalSupplementIntent | undefined> {
  if (reason === undefined) return undefined;
  const intent = { actorEmployeeId, reason: reason.trim() };
  await validateHistoricalSupplement(tx, orgId, intent, businessDates);
  return intent;
}
async function validateHistoricalSupplement(
  tx: Tx,
  orgId: string,
  intent: HistoricalSupplementIntent,
  businessDates: readonly string[],
  currentRead = false
) {
  if (!intent.reason.trim() || intent.reason.length > 2048)
    throw new ResourceAttributesError("RESOURCE_HISTORICAL_REASON_REQUIRED");
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
  if (
    businessDates
      .map(normalizeHistoricalBusinessDate)
      .some(
        (date) =>
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
          new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date ||
          date > today
      )
  )
    throw new ResourceAttributesError("RESOURCE_HISTORICAL_DATE_INVALID");
  const actor = currentRead
    ? (
        await tx.$queryRaw<{ id: string }[]>(
          Prisma.sql`SELECT id FROM employees WHERE org_id = ${orgId} AND id = ${intent.actorEmployeeId} AND role = 'admin' AND disabled = false FOR SHARE`
        )
      )[0]
    : await tx.employee.findFirst({
        where: { orgId, id: intent.actorEmployeeId, role: "admin", disabled: false },
        select: { id: true }
      });
  if (!actor) throw new ResourceAttributesError("AUTHORIZATION_ADMIN_REQUIRED");
}
function normalizeHistoricalBusinessDate(date: string): string {
  // Structured upload windows use YYYYMMDD; parsed rows and partitions use YYYY-MM-DD.
  return /^\d{8}$/.test(date)
    ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
    : date;
}
export async function requireCurrentDirectoryEligibility(
  tx: Tx,
  input: {
    orgId: string;
    categoryId: string;
    scopes: ResourceReadRequirement["scopes"];
    targetId: string;
    preserveExistingReferences?: boolean;
    historicalSupplement?: HistoricalSupplementIntent;
    businessDates?: readonly string[];
  }
) {
  if (input.historicalSupplement)
    await validateHistoricalSupplement(
      tx,
      input.orgId,
      input.historicalSupplement,
      input.businessDates ?? [],
      true
    );
  const retired: { kind: string; identity: string[] }[] = [];
  // Locking reads observe the current directory even if the surrounding transaction read business rows before its version lock.
  const category = (
    await tx.$queryRaw<{ retired: boolean }[]>(
      Prisma.sql`SELECT retired FROM business_categories WHERE org_id = ${input.orgId} AND id = ${input.categoryId} FOR SHARE`
    )
  )[0];
  if (!category) throw new ResourceAttributesError("RESOURCE_CATEGORY_NOT_CONFIGURED");
  if (category.retired) retired.push({ kind: "category", identity: [input.categoryId] });
  const requiredDimensions = await tx.$queryRaw<{ dimensionId: string }[]>(
    Prisma.sql`SELECT dimension_id AS dimensionId FROM business_category_dimensions WHERE org_id = ${input.orgId} AND category_id = ${input.categoryId} FOR SHARE`
  );
  for (const scope of input.scopes) {
    if (requiredDimensions.some(({ dimensionId }) => !scope.dimensions[dimensionId]))
      throw new ResourceAttributesError("RESOURCE_ATTRIBUTES_NOT_READY");
    if (scope.ownership === "store") {
      const store = (
        await tx.$queryRaw<{ retired: boolean }[]>(
          Prisma.sql`SELECT retired FROM business_stores WHERE org_id = ${input.orgId} AND enterprise_key = ${scope.enterpriseKey} AND name = ${scope.storeName!} FOR SHARE`
        )
      )[0];
      if (store?.retired)
        retired.push({ kind: "store", identity: [scope.enterpriseKey, scope.storeName!] });
    }
    for (const [dimensionId, valueId] of Object.entries(scope.dimensions)) {
      const dimension = (
        await tx.$queryRaw<{ retired: boolean }[]>(
          Prisma.sql`SELECT retired FROM business_dimensions WHERE org_id = ${input.orgId} AND id = ${dimensionId} FOR SHARE`
        )
      )[0];
      const value = (
        await tx.$queryRaw<{ retired: boolean }[]>(
          Prisma.sql`SELECT retired FROM business_dimension_values WHERE org_id = ${input.orgId} AND dimension_id = ${dimensionId} AND id = ${valueId} FOR SHARE`
        )
      )[0];
      if (!dimension || !value) throw new ResourceAttributesError("RESOURCE_ATTRIBUTES_NOT_READY");
      if (dimension.retired) retired.push({ kind: "dimension", identity: [dimensionId] });
      if (value.retired) retired.push({ kind: "value", identity: [dimensionId, valueId] });
    }
  }
  if (retired.length && !input.preserveExistingReferences && !input.historicalSupplement)
    throw new ResourceAttributesError("RESOURCE_DIRECTORY_RETIRED");
  if (input.historicalSupplement)
    await tx.auditLog.create({
      data: {
        orgId: input.orgId,
        actorEmployeeId: input.historicalSupplement.actorEmployeeId,
        action: "resource.historical_supplement.authorized",
        targetType: "business_resource",
        targetId: input.targetId,
        result: "succeeded",
        clientSource: "admin",
        metadata: {
          historicalSupplement: input.historicalSupplement as unknown as Prisma.InputJsonValue,
          retired,
          businessDates: (input.businessDates ?? []).map(normalizeHistoricalBusinessDate)
        }
      }
    });
}
export async function persistResourceAttributes(
  tx: Tx,
  input: Omit<ResourceAuthorizationWrite, "actorId" | "expectedVersion">,
  options: {
    publication?: boolean;
    historicalSupplement?: HistoricalSupplementIntent;
    businessDates?: readonly string[];
  } = {}
) {
  const category = await tx.businessCategory.findUniqueOrThrow({
    where: { orgId_id: { orgId: input.orgId, id: input.categoryId } },
    include: categoriesInclude
  });
  const rule = categoryRule(category);
  if (
    (input.kind === "evidence") !== (rule.kind === "evidence") ||
    (input.kind === "quarantine_certificate" && category.key !== "quarantine_certificate") ||
    (input.kind === "ledger_pdf" && category.key !== "ledger_pdf")
  )
    throw new Error("RESOURCE_CATEGORY_KIND_MISMATCH");
  if (
    input.scopes.length === 0 ||
    input.scopes.some((scope) => !validateBusinessScope(scope, rule)) ||
    (rule.kind === "evidence"
      ? !isBusinessClearance(input.fileConfidentialityLevel)
      : input.fileConfidentialityLevel != null)
  )
    throw new Error("RESOURCE_ATTRIBUTES_NOT_READY");
  if (input.kind === "quarantine_certificate" || input.kind === "ledger_pdf")
    if (input.scopes.length !== 1 || input.scopes[0]!.ownership !== "store")
      throw new Error("RESOURCE_SINGLE_STORE_REQUIRED");
  const where = { orgId_id: { orgId: input.orgId, id: input.id } };
  const before = await tx.businessResource.findUnique({ where, include: resourcesInclude });
  if (
    before &&
    (before.kind !== input.kind ||
      before.resourceKey !== input.resourceKey ||
      before.documentId !== (input.documentId ?? null) ||
      before.sourceDocumentId !== (input.sourceDocumentId ?? null))
  )
    throw new Error("RESOURCE_IDENTITY_IMMUTABLE");
  if (input.sourceDocumentId && input.kind !== "source_fragment")
    throw new Error("SOURCE_FRAGMENT_REQUIRED");
  if (input.kind === "source_fragment" && !input.sourceDocumentId)
    throw new Error("SOURCE_DOCUMENT_REQUIRED");
  if (
    before &&
    input.kind === "source_fragment" &&
    (before.categoryId !== input.categoryId ||
      before.valid !== input.valid ||
      !preservesSourceTuples(resourceRequirement(before).scopes, input.scopes))
  )
    throw new Error("SOURCE_REQUIREMENTS_IMMUTABLE");
  await requireCurrentDirectoryEligibility(tx, {
    orgId: input.orgId,
    categoryId: input.categoryId,
    scopes: input.scopes,
    targetId: input.id,
    preserveExistingReferences:
      !options.publication &&
      !!before &&
      before.categoryId === input.categoryId &&
      before.valid === input.valid &&
      isDeepStrictEqual(
        canonicalScopes(resourceRequirement(before).scopes),
        canonicalScopes(input.scopes)
      ),
    historicalSupplement: options.historicalSupplement,
    businessDates: options.businessDates
  });
  const contentChanged =
    before &&
    (before.valid !== input.valid ||
      // Source enrichment only adds required authorization metadata; source content and association stay intact.
      (input.kind !== "source_fragment" &&
        !isDeepStrictEqual(
          canonicalScopes(resourceRequirement(before).scopes),
          canonicalScopes(input.scopes)
        )));
  const data = {
    categoryId: input.categoryId,
    valid: input.valid,
    fileConfidentialityLevel: input.fileConfidentialityLevel ?? null
  };
  await tx.businessResource.upsert({
    where,
    create: {
      orgId: input.orgId,
      id: input.id,
      kind: input.kind,
      resourceKey: input.resourceKey,
      documentId: input.documentId ?? null,
      sourceDocumentId: input.sourceDocumentId ?? null,
      ...data
    },
    update: {
      ...data,
      authorizationVersion: { increment: 1 },
      ...(contentChanged ? { contentVersion: { increment: 1 } } : {})
    }
  });
  await tx.businessResourceScope.deleteMany({
    where: { orgId: input.orgId, resourceId: input.id }
  });
  for (const scope of input.scopes) {
    const id = randomUUID().replaceAll("-", "");
    await tx.businessResourceScope.create({
      data: {
        orgId: input.orgId,
        resourceId: input.id,
        id,
        enterpriseKey: scope.enterpriseKey,
        ownership: scope.ownership,
        storeName: scope.storeName ?? null
      }
    });
    await tx.businessScopeDimension.createMany({
      data: Object.entries(scope.dimensions).map(([dimensionId, valueId]) => ({
        orgId: input.orgId,
        resourceId: input.id,
        scopeId: id,
        dimensionId,
        valueId
      }))
    });
  }
  return {
    before,
    after: await tx.businessResource.findUniqueOrThrow({ where, include: resourcesInclude })
  };
}
export function createBusinessAuthorizationRepository({ prisma }: { prisma: PrismaClient }) {
  async function loadAuthorizationSnapshot(
    employeeId: string,
    orgId: string,
    tx?: Tx
  ): Promise<AuthorizationSnapshot> {
    if (!tx)
      return prisma.$transaction((client) => loadAuthorizationSnapshot(employeeId, orgId, client));
    const employee = await tx.employee.findUnique({
      where: { orgId_id: { orgId, id: employeeId } }
    });
    if (!employee || employee.orgId !== orgId) throw new Error("AUTHORIZATION_ACCOUNT_NOT_FOUND");
    const state = await tx.businessAuthorizationState.findUnique({ where: { orgId } });
    const categories = (
      await tx.businessCategory.findMany({ where: { orgId }, include: categoriesInclude })
    ).map(categoryRule);
    const rows = await tx.businessGrant.findMany({
      where: { orgId, employeeId },
      include: grantsInclude
    });
    return {
      orgId,
      employeeId,
      role: employee.role,
      disabled: employee.disabled,
      clearance: employee.clearance,
      mode: state?.mode ?? "legacy",
      authorizationVersion: (state?.version ?? 0n).toString(),
      categories,
      grants: rows.map((row) => ({
        id: row.id,
        orgId,
        enterpriseKey: row.enterpriseKey,
        categoryIds: row.categories.map((c) => c.categoryId),
        ownership: row.ownership,
        ...(row.ownership === "store"
          ? {
              stores: row.allStores
                ? { kind: "all" as const }
                : { kind: "fixed" as const, values: row.stores.map((store) => store.storeName) }
            }
          : {}),
        dimensions: Object.fromEntries(
          row.dimensions.map((d) => [
            d.dimensionId,
            d.allValues
              ? { kind: "all" as const }
              : { kind: "fixed" as const, values: d.values.map((value) => value.valueId) }
          ])
        )
      }))
    };
  }
  async function mutate<T>(
    context: AuthorizationWriteContext,
    action: string,
    targetId: string,
    operation: (tx: Tx) => Promise<{ before: unknown; after: T }>
  ): Promise<{ authorizationVersion: string; value: T }> {
    if (!/^(0|[1-9]\d*)$/.test(context.expectedVersion))
      throw new Error("AUTHORIZATION_VERSION_CONFLICT");
    try {
      return await prisma.$transaction(async (tx) => {
        if (context.expectedVersion === "0")
          await tx.businessAuthorizationState.upsert({
            where: { orgId: context.orgId },
            create: { orgId: context.orgId },
            update: {}
          });
        const state = await tx.businessAuthorizationState.updateMany({
          where: { orgId: context.orgId, version: BigInt(context.expectedVersion) },
          data: { version: { increment: 1 } }
        });
        if (state.count !== 1) throw new Error("AUTHORIZATION_VERSION_CONFLICT");
        const actor = await tx.employee.findUnique({
          where: { orgId_id: { orgId: context.orgId, id: context.actorId } }
        });
        if (!actor || actor.orgId !== context.orgId || actor.disabled || actor.role !== "admin")
          throw new Error("AUTHORIZATION_ADMIN_REQUIRED");
        const { before, after } = await operation(tx);
        const version = BigInt(context.expectedVersion) + 1n;
        await tx.businessAuthorizationAudit.create({
          data: {
            orgId: context.orgId,
            actorId: context.actorId,
            action,
            targetId,
            before: before === null ? Prisma.JsonNull : json(before),
            after: after === null ? Prisma.JsonNull : json(after),
            outcome: "succeeded",
            version
          }
        });
        return { authorizationVersion: version.toString(), value: after };
      });
    } catch (error) {
      // The rejected mutation has rolled back. Record its result without advancing the version.
      // Do not copy driver messages or attempted resource data into the audit.
      const actor = await prisma.employee.findUnique({
        where: { orgId_id: { orgId: context.orgId, id: context.actorId } }
      });
      const state = await prisma.businessAuthorizationState.findUnique({
        where: { orgId: context.orgId }
      });
      if (actor?.orgId === context.orgId && state) {
        await prisma.businessAuthorizationAudit.create({
          data: {
            orgId: context.orgId,
            actorId: actor.id,
            action,
            targetId,
            before: Prisma.JsonNull,
            after: {
              code:
                error instanceof Error && error.message === "AUTHORIZATION_VERSION_CONFLICT"
                  ? "AUTHORIZATION_VERSION_CONFLICT"
                  : "WRITE_REJECTED"
            },
            outcome: "denied",
            version: state.version
          }
        });
      }
      throw error;
    }
  }
  async function listResourceReadRequirements(orgId: string, tx?: Tx) {
    const rows = await (tx ?? prisma).businessResource.findMany({
      where: { orgId },
      include: resourcesInclude
    });
    return rows.map((row) => ({ id: row.id, requirement: resourceRequirement(row) }));
  }
  async function writeGrants(
    tx: Tx,
    input: { orgId: string; employeeId: string; grants: BusinessGrant[] }
  ) {
    const snapshot = await loadAuthorizationSnapshot(input.employeeId, input.orgId, tx);
    await persistBusinessGrants(tx, input, snapshot.categories);
  }
  return {
    async listAccounts(orgId: string, actorId: string) {
      return prisma.$transaction(async (tx) => {
        const actor = await loadAuthorizationSnapshot(actorId, orgId, tx);
        if (actor.disabled || actor.role !== "admin")
          throw new Error("AUTHORIZATION_ADMIN_REQUIRED");
        const rows = await tx.employee.findMany({
          where: { orgId },
          select: { id: true, displayName: true, email: true }
        });
        return Promise.all(
          rows.map(async (row) => ({
            ...row,
            ...(await loadAuthorizationSnapshot(row.id, orgId, tx))
          }))
        );
      });
    },
    listCategories: (orgId: string) =>
      prisma.businessCategory.findMany({ where: { orgId }, include: categoriesInclude }),
    listDimensions: (orgId: string) =>
      prisma.businessDimension.findMany({ where: { orgId }, include: { values: true } }),
    configureAccount(
      input: AuthorizationWriteContext & {
        employeeId: string;
        clearance: number;
        grants: BusinessGrant[];
      }
    ) {
      return mutate(input, "account.permissions.configure", input.employeeId, async (tx) => {
        if (!isBusinessClearance(input.clearance)) throw new Error("INVALID_ACCOUNT_CLEARANCE");
        const before = await loadAuthorizationSnapshot(input.employeeId, input.orgId, tx);
        await writeGrants(tx, input);
        await tx.employee.update({
          where: { orgId_id: { orgId: input.orgId, id: input.employeeId } },
          data: { clearance: input.clearance }
        });
        return {
          before: { clearance: before.clearance, grants: before.grants },
          after: { clearance: input.clearance, grants: input.grants }
        };
      });
    },
    configureEvidenceDocument(
      input: AuthorizationWriteContext & {
        documentId: string;
        categoryId: string;
        fileConfidentialityLevel: number;
        scopes: ResourceReadRequirement["scopes"];
        historicalSupplementReason?: string;
      }
    ) {
      return mutate(input, "document.attributes.configure", input.documentId, async (tx) => {
        const document = await tx.document.findFirst({
          where: { orgId: input.orgId, id: input.documentId, documentKind: "evidence" }
        });
        if (!document) throw new Error("RESOURCE_NOT_FOUND");
        const existing = await tx.businessResource.findFirst({
          where: { orgId: input.orgId, documentId: input.documentId, kind: "evidence" }
        });
        const historicalSupplement = await bindHistoricalSupplementIntent(
          tx,
          input.orgId,
          input.actorId,
          input.historicalSupplementReason
        );
        await tx.document.update({
          where: { id: document.id },
          data: {
            sourceMetadata: {
              ...(document.sourceMetadata &&
              typeof document.sourceMetadata === "object" &&
              !Array.isArray(document.sourceMetadata)
                ? document.sourceMetadata
                : {}),
              historicalSupplement: historicalSupplement
                ? (historicalSupplement as unknown as Prisma.InputJsonValue)
                : null
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
            valid: document.status === "active" && !document.archivedAt
          },
          { historicalSupplement }
        );
      });
    },
    initializeOrganization: (orgId: string) =>
      prisma.businessAuthorizationState.upsert({ where: { orgId }, create: { orgId }, update: {} }),
    loadAuthorizationSnapshot,
    listResourceReadRequirements,
    async getResourceReadRequirement(
      id: string,
      orgId: string,
      tx?: Tx
    ): Promise<ResourceReadRequirement | null> {
      const row = await (tx ?? prisma).businessResource.findUnique({
        where: { orgId_id: { orgId, id } },
        include: resourcesInclude
      });
      return row ? resourceRequirement(row) : null;
    },
    async getSourceReadRequirements(
      sourceDocumentId: string,
      orgId: string,
      tx?: Tx
    ): Promise<ResourceReadRequirement[]> {
      const rows = await (tx ?? prisma).businessResource.findMany({
        where: { orgId, sourceDocumentId, kind: "source_fragment" },
        include: resourcesInclude
      });
      if (rows.length === 0) throw new Error("SOURCE_AUTHORIZATION_NOT_READY");
      return rows.map(resourceRequirement);
    },
    defineDimension(
      input: AuthorizationWriteContext & {
        id: string;
        name: string;
        retired?: boolean;
        createOnly?: boolean;
        updateOnly?: boolean;
      }
    ) {
      return mutate(input, "dimension.configure", input.id, async (tx) => {
        const where = { orgId_id: { orgId: input.orgId, id: input.id } };
        const before = await tx.businessDimension.findUnique({ where });
        if ((input.createOnly && before) || (input.updateOnly && !before))
          throw new Error("INVALID_DIMENSION_ID");
        const data = { name: input.name, retired: input.retired ?? before?.retired ?? false };
        return {
          before,
          after: await tx.businessDimension.upsert({
            where,
            create: { orgId: input.orgId, id: input.id, ...data },
            update: data
          })
        };
      });
    },
    defineDimensionValue(
      input: AuthorizationWriteContext & {
        id: string;
        dimensionId: string;
        name: string;
        retired?: boolean;
        createOnly?: boolean;
        updateOnly?: boolean;
      }
    ) {
      return mutate(
        input,
        "dimension_value.configure",
        `${input.dimensionId}/${input.id}`,
        async (tx) => {
          const where = {
            orgId_dimensionId_id: {
              orgId: input.orgId,
              dimensionId: input.dimensionId,
              id: input.id
            }
          };
          const before = await tx.businessDimensionValue.findUnique({ where });
          if ((input.createOnly && before) || (input.updateOnly && !before))
            throw new Error("INVALID_DIMENSION_VALUE_ID");
          const data = { name: input.name, retired: input.retired ?? before?.retired ?? false };
          return {
            before,
            after: await tx.businessDimensionValue.upsert({
              where,
              create: { orgId: input.orgId, dimensionId: input.dimensionId, id: input.id, ...data },
              update: data
            })
          };
        }
      );
    },
    configureCategory(input: CategoryWrite) {
      return mutate(input, "category.configure", input.id, async (tx) => {
        if (
          input.ownerships.length === 0 ||
          input.ownerships.some((value) => value !== "group" && value !== "store") ||
          new Set(input.requiredDimensionIds).size !== input.requiredDimensionIds.length ||
          (input.kind === "fixed"
            ? !input.key ||
              (input.confidentialityLevel !== null &&
                !isBusinessClearance(input.confidentialityLevel))
            : input.key !== undefined || input.confidentialityLevel !== null)
        )
          throw new Error("INVALID_CATEGORY_CONFIGURATION");
        if (
          input.kind === "fixed" &&
          (!input.key ||
            !Object.hasOwn(fixedCategoryOwnership, input.key) ||
            input.ownerships.length !== 1 ||
            input.ownerships[0] !== fixedCategoryOwnership[input.key])
        )
          throw new Error("INVALID_FIXED_CATEGORY");
        const where = { orgId_id: { orgId: input.orgId, id: input.id } };
        const before = await tx.businessCategory.findUnique({ where, include: categoriesInclude });
        if (input.createOnly && before) throw new Error("CATEGORY_ID_ALREADY_EXISTS");
        if (before && (before.kind !== input.kind || before.key !== (input.key ?? null)))
          throw new Error("CATEGORY_IDENTITY_IMMUTABLE");
        const data = {
          name: input.name,
          retired: input.retired ?? before?.retired ?? false,
          kind: input.kind,
          key: input.key ?? null,
          confidentialityLevel: input.confidentialityLevel,
          allowGroup: input.ownerships.includes("group"),
          allowStore: input.ownerships.includes("store")
        };
        await tx.businessCategory.upsert({
          where,
          create: { orgId: input.orgId, id: input.id, ...data },
          update: data
        });
        await tx.businessCategoryDimension.deleteMany({
          where: { orgId: input.orgId, categoryId: input.id }
        });
        await tx.businessCategoryDimension.createMany({
          data: input.requiredDimensionIds.map((dimensionId) => ({
            orgId: input.orgId,
            categoryId: input.id,
            dimensionId
          }))
        });
        return {
          before,
          after: await tx.businessCategory.findUniqueOrThrow({ where, include: categoriesInclude })
        };
      });
    },
    putStore(
      input: AuthorizationWriteContext & { enterpriseKey: string; name: string; retired?: boolean }
    ) {
      return mutate(input, "store.configure", input.name, async (tx) => {
        if (!input.enterpriseKey || !input.name.trim()) throw new Error("STORE_NAME_REQUIRED");
        const where = {
          orgId_enterpriseKey_name: {
            orgId: input.orgId,
            enterpriseKey: input.enterpriseKey,
            name: input.name
          }
        };
        const before = await tx.businessStore.findUnique({ where });
        return {
          before,
          after: await tx.businessStore.upsert({
            where,
            create: { ...where.orgId_enterpriseKey_name, retired: input.retired ?? false },
            update: { retired: input.retired ?? before?.retired ?? false }
          })
        };
      });
    },
    updateAccount(
      input: AuthorizationWriteContext & {
        employeeId: string;
        clearance?: number;
        disabled?: boolean;
      }
    ) {
      return mutate(input, "account.configure", input.employeeId, async (tx) => {
        if (input.clearance !== undefined && !isBusinessClearance(input.clearance))
          throw new Error("INVALID_ACCOUNT_CLEARANCE");
        const where = { orgId_id: { orgId: input.orgId, id: input.employeeId } };
        const before = await tx.employee.findUniqueOrThrow({ where });
        const after = await tx.employee.update({
          where,
          data: {
            ...(input.clearance !== undefined ? { clearance: input.clearance } : {}),
            ...(input.disabled !== undefined ? { disabled: input.disabled } : {})
          }
        });
        return {
          before: { clearance: before.clearance, disabled: before.disabled },
          after: { clearance: after.clearance, disabled: after.disabled }
        };
      });
    },
    replaceGrants(
      input: AuthorizationWriteContext & { employeeId: string; grants: BusinessGrant[] }
    ) {
      return mutate(input, "grants.replace", input.employeeId, async (tx) => {
        const snapshot = await loadAuthorizationSnapshot(input.employeeId, input.orgId, tx);
        for (const grant of input.grants)
          if (
            grant.orgId !== input.orgId ||
            validateBusinessGrant(grant, snapshot.categories).length
          )
            throw new Error("INVALID_BUSINESS_GRANT");
        await writeGrants(tx, input);
        return { before: snapshot.grants, after: input.grants };
      });
    },
    putResource(input: ResourceAuthorizationWrite) {
      return mutate(input, "resource.configure", input.id, async (tx) => {
        const historicalSupplement = await bindHistoricalSupplementIntent(
          tx,
          input.orgId,
          input.actorId,
          input.historicalSupplementReason
        );
        return persistResourceAttributes(tx, input, { historicalSupplement });
      });
    }
  };
}
