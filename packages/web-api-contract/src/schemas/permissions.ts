import { z } from "zod";

/** 权限设置面。路径参数只接受与旧页面相同的安全字符集。 */
export const permissionOrgParams = z
  .object({ orgId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) })
  .strict();

const userAccountId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const categoryId = z.string().min(1).max(64);
const dimensionId = z.string().min(1).max(64);
const documentId = z.string().min(1).max(64);
const exactName = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value.trim().length > 0);
const expectedVersion = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .describe("客户端读到的 authorizationVersion；过期写入整笔回滚。");

/** 维度/门店的可选范围；固定集合必须非空，避免存下一份空授权。 */
const selection = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z.object({ kind: z.literal("fixed"), values: z.array(z.string().min(1)).min(1) }).strict()
]);
const scopeDimensionValue = z.string().min(1);

/**
 * 资源作用域。组级授权没有门店名，门店级授权必须恰好一个。
 * 请求与响应共用：响应由 toResourceReadRequirement 产出，缺失门店名即组级。
 */
const scope = z.discriminatedUnion("ownership", [
  z
    .object({
      enterpriseKey: z.string().min(1),
      ownership: z.literal("group"),
      dimensions: z.record(z.string().min(1), scopeDimensionValue)
    })
    .strict(),
  z
    .object({
      enterpriseKey: z.string().min(1),
      ownership: z.literal("store"),
      storeName: exactName,
      dimensions: z.record(z.string().min(1), scopeDimensionValue)
    })
    .strict()
]);

// ---- 请求 ----

export const permissionAccountParams = permissionOrgParams.extend({ userAccountId });

export const permissionCategoryParams = permissionOrgParams.extend({ id: categoryId });

export const permissionDimensionParams = permissionOrgParams.extend({ dimensionId });

export const permissionDimensionIdParams = permissionOrgParams.extend({ id: dimensionId });

export const permissionDimensionValueParams = permissionOrgParams.extend({
  dimensionId,
  id: z.string().min(1).max(64)
});

export const permissionDocumentParams = permissionOrgParams.extend({ documentId });

export const permissionDocumentQuery = z
  .object({
    search: z.string().max(256).optional(),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/)
      .optional()
  })
  .strict();

export const permissionCutoverBody = z
  .object({ expectedVersion, confirm: z.literal(true) })
  .strict();

/** 账号授权条目；组级授权不带门店，门店级授权必须带门店选择。 */
const grant = z
  .object({
    id: z.string().min(1).max(64),
    orgId: z.string().min(1).max(64),
    enterpriseKey: z.string().min(1).max(128),
    categoryIds: z.array(z.string().min(1).max(64)).min(1),
    dimensions: z.record(z.string().min(1).max(64), selection)
  })
  .strict();

const grantBody = z.discriminatedUnion("ownership", [
  grant.extend({ ownership: z.literal("group") }).strict(),
  grant.extend({ ownership: z.literal("store"), stores: selection }).strict()
]);

export const permissionAccountUpdateBody = z
  .object({
    expectedVersion,
    clearance: z.number().int().min(0).max(3),
    grants: z.array(grantBody).max(100)
  })
  .strict();

export const permissionStoreBody = z
  .object({
    expectedVersion,
    enterpriseKey: z.string().min(1).max(128).optional(),
    enterpriseName: exactName.optional(),
    name: exactName,
    retired: z.boolean().optional()
  })
  .strict();

export const permissionVersionBody = z.object({ expectedVersion }).strict();

export const permissionCategoryCreateBody = z
  .object({
    expectedVersion,
    id: categoryId,
    name: exactName,
    kind: z.literal("evidence").optional(),
    ownerships: z.array(z.enum(["group", "store"])).min(1),
    requiredDimensionIds: z.array(z.string().min(1).max(64)),
    retired: z.boolean().optional()
  })
  .strict();

/** 固定类别只调整密级；证据类别只调整归属与必需维度。 */
export const permissionCategoryUpdateBody = z.union([
  z
    .object({
      expectedVersion,
      name: exactName,
      confidentialityLevel: z.number().int().min(0).max(3),
      retired: z.boolean().optional()
    })
    .strict(),
  z
    .object({
      expectedVersion,
      name: exactName,
      ownerships: z.array(z.enum(["group", "store"])).min(1),
      requiredDimensionIds: z.array(z.string().min(1).max(64)),
      retired: z.boolean().optional()
    })
    .strict()
]);

export const permissionDimensionCreateBody = z
  .object({
    expectedVersion,
    id: dimensionId,
    name: exactName,
    retired: z.boolean().optional()
  })
  .strict();

export const permissionDimensionUpdateBody = z
  .object({ expectedVersion, name: exactName, retired: z.boolean().optional() })
  .strict();

export const permissionDimensionValueCreateBody = z
  .object({
    expectedVersion,
    id: z.string().min(1).max(64),
    name: exactName,
    retired: z.boolean().optional()
  })
  .strict();

export const permissionDimensionValueUpdateBody = permissionDimensionUpdateBody;

export const permissionDocumentUpdateBody = z
  .object({
    expectedVersion,
    categoryId,
    fileConfidentialityLevel: z.number().int().min(0).max(3),
    scopes: z.array(scope).min(1).max(1000),
    historicalSupplementReason: z
      .string()
      .min(1)
      .max(2048)
      .refine((value) => value.trim().length > 0)
      .optional()
  })
  .strict();

export const permissionEnterpriseDeclareBody = z
  .object({ expectedVersion, name: exactName })
  .strict();

export const permissionEnterprisePreviewBody = z.object({ name: exactName }).strict();
// ---- 响应 ----

/** 写入成功信封：新版本号 + 应用后的值。 */
function versioned<T extends z.ZodType>(value: T) {
  return z.object({ authorizationVersion: z.string(), value }).strict();
}

const mode = z.enum(["legacy", "preparing", "enabled", "suspended"]);
const role = z.enum(["admin", "employee"]);
const ownership = z.enum(["group", "store"]);

const categoryRule = z
  .object({
    id: z.string(),
    key: z.string().optional(),
    kind: z.enum(["fixed", "evidence"]),
    confidentialityLevel: z.number().int().nullable(),
    ownerships: z.array(ownership),
    requiredDimensionIds: z.array(z.string())
  })
  .strict();

const storedGrant = z
  .object({
    id: z.string(),
    orgId: z.string(),
    enterpriseKey: z.string(),
    categoryIds: z.array(z.string()),
    ownership,
    stores: selection.optional(),
    dimensions: z.record(z.string(), selection)
  })
  .strict();

const snapshot = z
  .object({
    orgId: z.string(),
    userAccountId: z.string(),
    role,
    disabled: z.boolean(),
    clearance: z.number().int(),
    mode,
    authorizationVersion: z.string(),
    categories: z.array(categoryRule),
    grants: z.array(storedGrant)
  })
  .strict();

const storeReviewEnterprise = z
  .object({ enterpriseKey: z.string(), enterpriseName: z.string() })
  .strict();

/** GET /permissions/me：当前账号的授权卡片加审核企业可选范围。 */
export const permissionCardResponse = snapshot
  .extend({
    storeReviewEnterprises: z
      .object({
        complete: z.literal(true),
        write: z.array(storeReviewEnterprise),
        read: z.array(storeReviewEnterprise)
      })
      .strict()
  })
  .strict();

const account = snapshot.extend({ displayName: z.string(), email: z.string(), id: z.string() });

/** GET /permissions/accounts：同企业账号目录。 */
export const permissionAccountsResponse = z.object({ accounts: z.array(account) }).strict();

/** GET /permissions/accounts/:userAccountId：单个账号的授权快照。 */
export const permissionAccountResponse = snapshot;

export const permissionAccountUpdateResponse = versioned(
  z.object({ clearance: z.number().int(), grants: z.array(storedGrant) }).strict()
);

const storeRow = z
  .object({
    orgId: z.string(),
    enterpriseKey: z.string(),
    name: z.string(),
    retired: z.boolean(),
    storeId: z.string().uuid().optional(),
    officialName: z.string().optional(),
    confirmation: z.enum(["pending", "confirmed", "historical"]).optional(),
    version: z.string().optional()
  })
  .strict();

export const permissionStoresResponse = z
  .object({ authorizationVersion: z.string(), stores: z.array(storeRow) })
  .strict();

export const permissionStoreResponse = versioned(
  storeRow.extend({ enterpriseName: z.string() }).strict()
);

const categoryDimensionRow = z
  .object({ orgId: z.string(), categoryId: z.string(), dimensionId: z.string() })
  .strict();

const categoryRow = z
  .object({
    orgId: z.string(),
    id: z.string(),
    key: z.string().nullable(),
    name: z.string(),
    kind: z.enum(["fixed", "evidence"]),
    confidentialityLevel: z.number().int().nullable(),
    allowGroup: z.boolean(),
    allowStore: z.boolean(),
    retired: z.boolean(),
    dimensions: z.array(categoryDimensionRow)
  })
  .strict();

export const permissionCategoriesResponse = z
  .object({ authorizationVersion: z.string(), categories: z.array(categoryRow) })
  .strict();

export const permissionCategoryResponse = versioned(categoryRow);

export const permissionCategoryInitializeResponse = versioned(
  z.object({ createdCount: z.number().int() }).strict()
);

const dimensionRow = z
  .object({ orgId: z.string(), id: z.string(), name: z.string(), retired: z.boolean() })
  .strict();

const dimensionValueRow = z
  .object({
    orgId: z.string(),
    dimensionId: z.string(),
    id: z.string(),
    name: z.string(),
    retired: z.boolean()
  })
  .strict();

export const permissionDimensionsResponse = z
  .object({
    authorizationVersion: z.string(),
    dimensions: z.array(dimensionRow.extend({ values: z.array(dimensionValueRow) }).strict())
  })
  .strict();

export const permissionDimensionResponse = versioned(dimensionRow);

export const permissionDimensionValueResponse = versioned(dimensionValueRow);

export const permissionDocumentsResponse = z
  .object({
    authorizationVersion: z.string(),
    documents: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          status: z.string(),
          categoryId: z.string().nullable(),
          fileConfidentialityLevel: z.number().int().nullable(),
          valid: z.boolean(),
          scopes: z.array(scope)
        })
        .strict()
    ),
    nextCursor: z.string().nullable()
  })
  .strict();

const scopeDimensionRow = z
  .object({
    orgId: z.string(),
    resourceId: z.string(),
    scopeId: z.string(),
    dimensionId: z.string(),
    valueId: z.string()
  })
  .strict();

const resourceScopeRow = z
  .object({
    orgId: z.string(),
    resourceId: z.string(),
    id: z.string(),
    enterpriseKey: z.string(),
    ownership,
    storeName: z.string().nullable(),
    dimensions: z.array(scopeDimensionRow)
  })
  .strict();

const resourceRow = z
  .object({
    orgId: z.string(),
    id: z.string(),
    kind: z.enum([
      "store_review",
      "cost_card",
      "evidence",
      "structured",
      "quarantine_certificate",
      "ledger_pdf",
      "source_fragment"
    ]),
    resourceKey: z.string(),
    categoryId: z.string(),
    valid: z.boolean(),
    fileConfidentialityLevel: z.number().int().nullable(),
    // Prisma BigInt 经 JSON 序列化后是十进制字符串。
    contentVersion: z.string(),
    authorizationVersion: z.string(),
    documentId: z.string().nullable(),
    sourceDocumentId: z.string().nullable(),
    scopes: z.array(resourceScopeRow)
  })
  .strict();

export const permissionDocumentUpdateResponse = versioned(resourceRow);

const enterpriseIdentity = z
  .object({ orgId: z.string(), enterpriseKey: z.string(), enterpriseName: z.string() })
  .strict();

const enterpriseOption = z
  .object({ enterpriseKey: z.string(), enterpriseName: z.string() })
  .strict();

export const permissionEnterprisesResponse = z
  .object({ authorizationVersion: z.string(), enterprises: z.array(enterpriseOption) })
  .strict();

export const permissionEnterpriseDeclareResponse = versioned(enterpriseIdentity);

/** POST /permissions/enterprises/preview：只回显规范化后的企业标识，不落库。 */
export const permissionEnterprisePreviewResponse = enterpriseOption;

export const permissionCutoverResponse = z
  .object({
    authorizationVersion: z.string(),
    mode,
    ready: z.boolean(),
    missing: z.array(z.object({ code: z.string(), targetId: z.string() }).strict()),
    accountsWithoutGrants: z.array(z.string())
  })
  .strict();

export const permissionCutoverModeResponse = versioned(z.object({ mode }).strict());
