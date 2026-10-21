import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { loadStoreReviewEnterpriseOptions } from "./store-review-enterprises.js";
import { Prisma, type PrismaClient, type BusinessResourceKind } from "@prisma/client";
import {
  FIXED_BUSINESS_CATEGORY_OWNERSHIP,
  isBusinessClearance,
  normalizeEnterpriseIdentity,
  validateBusinessGrant,
  validateBusinessScope,
  type AuthorizationSnapshot,
  type BusinessCategoryRule,
  type BusinessGrant,
  type ResourceReadRequirement
} from "@smedc/domain";

import {
  categoriesInclude,
  resourcesInclude,
  toBusinessCategoryRule,
  toResourceReadRequirement,
  loadBusinessGrants
} from "./business-authorization-records.js";
import { initializeFixedBusinessCategories } from "./fixed-business-categories.js";

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
type Tx = Prisma.TransactionClient;
function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item
    )
  ) as Prisma.InputJsonValue;
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
  const rule = toBusinessCategoryRule(category);
  if (
    (input.kind === "evidence") !== (rule.kind === "evidence") ||
    (input.kind === "quarantine_certificate" && category.key !== "quarantine_certificate") ||
    (input.kind === "ledger_pdf" && category.key !== "ledger_pdf") ||
    (input.kind === "cost_card" && category.key !== "cost_cards") ||
    (input.kind === "store_review" && category.key !== "store_reviews") ||
    (category.key === "store_reviews" && input.kind !== "store_review")
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
  if (
    input.kind === "quarantine_certificate" ||
    input.kind === "ledger_pdf" ||
    input.kind === "store_review"
  )
    if (input.scopes.length !== 1 || input.scopes[0]!.ownership !== "store")
      throw new Error("RESOURCE_SINGLE_STORE_REQUIRED");
  if (input.kind === "store_review" && input.documentId !== undefined)
    throw new Error("RESOURCE_IDENTITY_IMMUTABLE");
  if (
    input.kind === "cost_card" &&
    (input.scopes.length !== 1 ||
      input.scopes[0]!.ownership !== "group" ||
      input.documentId !== undefined)
  )
    throw new Error("RESOURCE_SINGLE_GROUP_REQUIRED");
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
      !preservesSourceTuples(toResourceReadRequirement(before).scopes, input.scopes))
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
        canonicalScopes(toResourceReadRequirement(before).scopes),
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
        input.kind !== "evidence" &&
        !isDeepStrictEqual(
          canonicalScopes(toResourceReadRequirement(before).scopes),
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
export interface PermissionOperatorAudit {
  operatorId: string;
  requestReference: string;
  reason: string;
}
export function createBusinessAuthorizationRepository({
  prisma,
  operatorAudit
}: {
  prisma: PrismaClient;
  operatorAudit?: PermissionOperatorAudit;
}) {
  // Only a trusted operator process supplies this factory option; HTTP bodies never select it.
  const operator = operatorAudit ? { ...operatorAudit } : undefined;
  if (
    operator &&
    ([operator.operatorId, operator.requestReference, operator.reason].some(
      (value) =>
        typeof value !== "string" ||
        !value.trim() ||
        [...value].some((character) => character.charCodeAt(0) < 32)
    ) ||
      operator.operatorId.length > 128 ||
      operator.requestReference.length > 256 ||
      operator.reason.length > 2048)
  )
    throw new Error("INVALID_OPERATOR_AUDIT_CONTEXT");
  async function writeAudit(
    client: Pick<Tx, "businessAuthorizationAudit" | "auditLog">,
    data: Prisma.BusinessAuthorizationAuditUncheckedCreateInput
  ) {
    const audit = await client.businessAuthorizationAudit.create({
      data: { ...data, action: operator ? `operator.${data.action}` : data.action }
    });
    if (operator)
      await client.auditLog.create({
        data: {
          orgId: data.orgId,
          actorEmployeeId: null,
          action: "permissions.operator.change",
          targetType: "business_authorization_audit",
          targetId: audit.id,
          result: data.outcome,
          clientSource: "operator_cli",
          metadata: json({
            operator,
            requestedByAdminId: data.actorId,
            operation: data.action,
            targetId: data.targetId,
            authorizationVersion: data.version
          })
        }
      });
  }
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
    return {
      ...(await loadOrganizationAuthorization(tx, orgId)),
      employeeId,
      role: employee.role,
      disabled: employee.disabled,
      clearance: employee.clearance,
      grants: (await loadBusinessGrants(tx, orgId, employeeId)).get(employeeId) ?? []
    };
  }
  async function loadOrganizationAuthorization(tx: Tx, orgId: string) {
    const state = await tx.businessAuthorizationState.findUnique({ where: { orgId } });
    const categories = (
      await tx.businessCategory.findMany({ where: { orgId }, include: categoriesInclude })
    ).map(toBusinessCategoryRule);
    return {
      orgId,
      mode: state?.mode ?? "legacy",
      authorizationVersion: (state?.version ?? 0n).toString(),
      categories
    };
  }
  async function saveEnterpriseIdentity(
    tx: Tx,
    orgId: string,
    input: { enterpriseKey?: string; enterpriseName?: string }
  ) {
    let identity: { enterpriseKey: string; enterpriseName: string } | undefined;
    if (input.enterpriseName !== undefined) {
      if (!input.enterpriseName.trim() || input.enterpriseName.length > 255)
        throw new Error("INVALID_ENTERPRISE_IDENTITY");
      identity = normalizeEnterpriseIdentity(input.enterpriseName);
      if (identity.enterpriseKey.length > 128) throw new Error("INVALID_ENTERPRISE_IDENTITY");
      if (input.enterpriseKey !== undefined && input.enterpriseKey !== identity.enterpriseKey)
        throw new Error("ENTERPRISE_NAME_CONFLICT");
    }
    const enterpriseKey = identity?.enterpriseKey ?? input.enterpriseKey;
    if (!enterpriseKey) throw new Error("ENTERPRISE_NAME_REQUIRED");
    const where = { orgId_enterpriseKey: { orgId, enterpriseKey } };
    const before = await tx.businessEnterpriseIdentity.findUnique({ where });
    if (before) {
      if (
        before.enterpriseKey !== enterpriseKey ||
        (identity && before.enterpriseName !== identity.enterpriseName)
      )
        throw new Error("ENTERPRISE_NAME_CONFLICT");
      return { before, after: before };
    }
    if (!identity) throw new Error("ENTERPRISE_NAME_REQUIRED");
    return {
      before: null,
      after: await tx.businessEnterpriseIdentity.create({ data: { orgId, ...identity } })
    };
  }
  async function mutate<T>(
    context: AuthorizationWriteContext,
    action: string,
    targetId: string,
    operation: (tx: Tx, assertWithinDeadline: () => void) => Promise<{ before: unknown; after: T }>
  ): Promise<{ authorizationVersion: string; value: T }> {
    if (!/^(0|[1-9]\d*)$/.test(context.expectedVersion))
      throw new Error("AUTHORIZATION_VERSION_CONFLICT");
    const timeout = 5000;
    // Start conservatively before acquisition so synchronous inspection cannot outrun
    // the driver's timer and send a write on a connection that has already rolled back.
    const deadline = performance.now() + timeout;
    const assertWithinDeadline = () => {
      if (performance.now() >= deadline) throw new Error("AUTHORIZATION_TRANSACTION_EXPIRED");
    };
    try {
      return await prisma.$transaction(
        async (tx) => {
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
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM employees WHERE org_id = ${context.orgId} AND id = ${context.actorId} FOR SHARE`
          );
          const actor = await tx.employee.findUnique({
            where: { orgId_id: { orgId: context.orgId, id: context.actorId } }
          });
          if (!actor || actor.orgId !== context.orgId || actor.disabled || actor.role !== "admin")
            throw new Error("AUTHORIZATION_ADMIN_REQUIRED");
          const { before, after } = await operation(tx, assertWithinDeadline);
          assertWithinDeadline();
          const version = BigInt(context.expectedVersion) + 1n;
          await writeAudit(tx, {
            orgId: context.orgId,
            actorId: context.actorId,
            action,
            targetId,
            before: before === null ? Prisma.JsonNull : json(before),
            after: after === null ? Prisma.JsonNull : json(after),
            outcome: "succeeded",
            version
          });
          return { authorizationVersion: version.toString(), value: after };
        },
        { timeout }
      );
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
        const deniedAudit: Prisma.BusinessAuthorizationAuditUncheckedCreateInput = {
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
        };
        if (operator) await prisma.$transaction((tx) => writeAudit(tx, deniedAudit));
        else await writeAudit(prisma, deniedAudit);
      }
      throw error;
    }
  }
  return {
    initializeFixedCategories(input: AuthorizationWriteContext) {
      return mutate(input, "categories.initialize", input.orgId, async (tx) => {
        const before = await tx.businessCategory.findMany({
          where: { orgId: input.orgId },
          select: { id: true, key: true }
        });
        const result = await initializeFixedBusinessCategories(tx, input.orgId);
        return { before, after: { createdCount: result.count } };
      });
    },
    inspectAuthorizationCutover<T>(orgId: string, inspect: (tx: Tx) => Promise<T>) {
      return prisma.$transaction(async (tx) => {
        const state = await tx.businessAuthorizationState.findUnique({ where: { orgId } });
        return {
          authorizationVersion: (state?.version ?? 0n).toString(),
          mode: state?.mode ?? "legacy",
          inspection: await inspect(tx)
        };
      });
    },
    activateAuthorizationCutover(
      input: AuthorizationWriteContext & { confirm: true },
      inspect: (tx: Tx) => Promise<{ ready: boolean }>
    ) {
      return mutate(
        input,
        "authorization.cutover.activate",
        input.orgId,
        async (tx, assertWithinDeadline) => {
          const before = await tx.businessAuthorizationState.findUniqueOrThrow({
            where: { orgId: input.orgId }
          });
          if (input.confirm !== true) throw new Error("AUTHORIZATION_CONFIRMATION_REQUIRED");
          if (before.mode === "suspended") throw new Error("AUTHORIZATION_SUSPENDED");
          if (!(await inspect(tx)).ready) throw new Error("AUTHORIZATION_CUTOVER_NOT_READY");
          assertWithinDeadline();
          const after = await tx.businessAuthorizationState.update({
            where: { orgId: input.orgId },
            data: { mode: "enabled" }
          });
          return { before: { mode: before.mode }, after: { mode: after.mode } };
        }
      );
    },
    suspendAuthorizationReads(input: AuthorizationWriteContext & { confirm: true }) {
      return mutate(input, "authorization.reads.suspend", input.orgId, async (tx) => {
        if (input.confirm !== true) throw new Error("AUTHORIZATION_CONFIRMATION_REQUIRED");
        const before = await tx.businessAuthorizationState.findUniqueOrThrow({
          where: { orgId: input.orgId }
        });
        if (before.mode !== "enabled" && before.mode !== "suspended")
          throw new Error("AUTHORIZATION_NOT_ENABLED");
        const after = await tx.businessAuthorizationState.update({
          where: { orgId: input.orgId },
          data: { mode: "suspended" }
        });
        return { before: { mode: before.mode }, after: { mode: after.mode } };
      });
    },
    async listAccounts(orgId: string, actorId: string) {
      return prisma.$transaction(async (tx) => {
        const rows = await tx.employee.findMany({
          where: { orgId },
          select: {
            id: true,
            displayName: true,
            email: true,
            role: true,
            disabled: true,
            clearance: true
          }
        });
        const actor = rows.find((row) => row.id === actorId);
        if (!actor || actor.disabled || actor.role !== "admin")
          throw new Error("AUTHORIZATION_ADMIN_REQUIRED");
        const organization = await loadOrganizationAuthorization(tx, orgId);
        const grants = await loadBusinessGrants(tx, orgId);
        return rows.map(({ id, ...account }) => ({
          ...organization,
          ...account,
          id,
          employeeId: id,
          grants: grants.get(id) ?? []
        }));
      });
    },
    listCategories: (orgId: string) =>
      prisma.businessCategory.findMany({ where: { orgId }, include: categoriesInclude }),
    listStores: (orgId: string) => prisma.businessStore.findMany({ where: { orgId } }),
    listDimensions: (orgId: string) =>
      prisma.businessDimension.findMany({ where: { orgId }, include: { values: true } }),
    async configureAccountRole(
      input: AuthorizationWriteContext & { employeeId: string; role: unknown }
    ) {
      if (!operator) throw new Error("AUTHORIZATION_OPERATOR_REQUIRED");
      return mutate(
        input,
        "account.role.configure",
        input.employeeId,
        async (tx, assertWithinDeadline) => {
          const role = input.role;
          if (role !== "admin" && role !== "employee") throw new Error("INVALID_ACCOUNT_ROLE");
          const before = await tx.employee.findUnique({
            where: { orgId_id: { orgId: input.orgId, id: input.employeeId } },
            select: { role: true, disabled: true }
          });
          if (!before) throw new Error("AUTHORIZATION_ACCOUNT_NOT_FOUND");
          if (before.role === "admin" && !before.disabled && role === "employee") {
            const otherAdmins = await tx.employee.count({
              where: {
                orgId: input.orgId,
                role: "admin",
                disabled: false,
                id: { not: input.employeeId }
              }
            });
            if (!otherAdmins) throw new Error("AUTHORIZATION_LAST_ADMIN_REQUIRED");
          }
          assertWithinDeadline();
          await tx.employee.update({
            where: { orgId_id: { orgId: input.orgId, id: input.employeeId } },
            data: { role }
          });
          return { before: { role: before.role }, after: { role } };
        }
      );
    },
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
        const reviewCategory = before.categories.find(
          (category) => category.key === "store_reviews"
        );
        const reviewEnterprises = [
          ...new Set(
            input.grants
              .filter((grant) => reviewCategory && grant.categoryIds.includes(reviewCategory.id))
              .map((grant) => grant.enterpriseKey)
          )
        ];
        if (reviewEnterprises.length) {
          const registered = await tx.businessEnterpriseIdentity.findMany({
            where: { orgId: input.orgId, enterpriseKey: { in: reviewEnterprises } },
            select: { enterpriseKey: true }
          });
          if (
            reviewEnterprises.some(
              (key) => !registered.some((identity) => identity.enterpriseKey === key)
            )
          )
            throw new Error("ENTERPRISE_NAME_REQUIRED");
        }
        await persistBusinessGrants(tx, input, before.categories);
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
          where: { orgId: input.orgId, documentId: input.documentId, kind: "evidence" },
          include: resourcesInclude
        });
        const historicalSupplement = await bindHistoricalSupplementIntent(
          tx,
          input.orgId,
          input.actorId,
          input.historicalSupplementReason
        );
        const valid = document.status === "active" && !document.archivedAt;
        const unchangedReferences =
          !!existing &&
          existing.categoryId === input.categoryId &&
          existing.valid === valid &&
          isDeepStrictEqual(
            canonicalScopes(toResourceReadRequirement(existing).scopes),
            canonicalScopes(input.scopes)
          );
        const metadata =
          document.sourceMetadata &&
          typeof document.sourceMetadata === "object" &&
          !Array.isArray(document.sourceMetadata)
            ? document.sourceMetadata
            : {};
        // Retain a pending approval without using it to authorize a different selection.
        const retainedIntent =
          historicalSupplement ??
          (unchangedReferences
            ? readHistoricalSupplementIntent(metadata["historicalSupplement"])
            : undefined);
        await tx.document.update({
          where: { id: document.id },
          data: {
            confidentialityLevel: input.fileConfidentialityLevel,
            sourceMetadata: {
              ...metadata,
              historicalSupplement: retainedIntent
                ? (retainedIntent as unknown as Prisma.InputJsonValue)
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
            valid
          },
          { historicalSupplement }
        );
      });
    },
    loadAuthorizationSnapshot,
    loadPermissionCard(employeeId: string, orgId: string) {
      return prisma.$transaction(
        async (tx) => {
          const snapshot = await loadAuthorizationSnapshot(employeeId, orgId, tx);
          return {
            ...snapshot,
            storeReviewEnterprises: await loadStoreReviewEnterpriseOptions(tx, snapshot)
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
      );
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
            !Object.hasOwn(FIXED_BUSINESS_CATEGORY_OWNERSHIP, input.key) ||
            input.ownerships.length !== 1 ||
            input.ownerships[0] !==
              FIXED_BUSINESS_CATEGORY_OWNERSHIP[
                input.key as keyof typeof FIXED_BUSINESS_CATEGORY_OWNERSHIP
              ])
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
    declareEnterpriseIdentity(input: AuthorizationWriteContext & { name: string }) {
      return mutate(input, "enterprise.identity.declare", "business-enterprise", async (tx) => {
        return saveEnterpriseIdentity(tx, input.orgId, { enterpriseName: input.name });
      });
    },
    putStore(
      input: AuthorizationWriteContext & {
        enterpriseKey?: string;
        enterpriseName?: string;
        name: string;
        retired?: boolean;
      }
    ) {
      return mutate(input, "store.configure", input.name, async (tx) => {
        if (!input.name.trim()) throw new Error("STORE_NAME_REQUIRED");
        const identity = await saveEnterpriseIdentity(tx, input.orgId, input);
        if (!identity.before)
          await writeAudit(tx, {
            orgId: input.orgId,
            actorId: input.actorId,
            action: "enterprise.identity.declare",
            targetId: "business-enterprise",
            before: Prisma.JsonNull,
            after: json(identity.after),
            outcome: "succeeded",
            version: BigInt(input.expectedVersion) + 1n
          });
        const where = {
          orgId_enterpriseKey_name: {
            orgId: input.orgId,
            enterpriseKey: identity.after.enterpriseKey,
            name: input.name
          }
        };
        const before = await tx.businessStore.findUnique({ where });
        return {
          before,
          after: {
            ...(await tx.businessStore.upsert({
              where,
              create: { ...where.orgId_enterpriseKey_name, retired: input.retired ?? false },
              update: { retired: input.retired ?? before?.retired ?? false }
            })),
            enterpriseName: identity.after.enterpriseName
          }
        };
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
