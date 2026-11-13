import { Readable } from "node:stream";
import { z } from "zod";

/** 台账下载中心只下发定位身份所需的字段；邮箱、角色、密级与凭据指纹不出现在这里。 */
export const ledgerContextIdentitySchema = z
  .object({
    userAccountId: z.string().min(1),
    orgId: z.string().min(1),
    displayName: z.string().min(1),
    organizationName: z.string().min(1)
  })
  .strict();

export type LedgerContextIdentity = z.output<typeof ledgerContextIdentitySchema>;

/** 与交付服务共享的静态限额；前端只用于展示与禁用，不据此做授权判断。 */
export const ledgerLimitsSchema = z
  .object({
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    stores: z.number().int().nonnegative(),
    dates: z.number().int().nonnegative(),
    pageSize: z.number().int().positive(),
    deadlineMs: z.number().int().nonnegative(),
    retentionMs: z.number().int().nonnegative()
  })
  .strict();

export type LedgerLimits = z.output<typeof ledgerLimitsSchema>;

export const ledgerContextResponseSchema = z
  .object({
    identity: ledgerContextIdentitySchema,
    /** 所有台账写操作（筛选、打包、领取链接）必须回传的 CSRF 令牌。 */
    csrfToken: z.string().min(1),
    limits: ledgerLimitsSchema
  })
  .strict();

export type LedgerContextResponse = z.output<typeof ledgerContextResponseSchema>;

/** 这些写接口不接受查询参数；多余参数一律 400，而不是被静默忽略。 */
export const ledgerEmptyQuerySchema = z.object({}).strict();

const ledgerStoreNameSchema = z.string().min(1).max(512);
const ledgerDateSchema = z.iso.date();

/** 单个台账分区身份；门店名保持原样，不做大小写或 Unicode 归一化。 */
export const ledgerPdfSelectionItemSchema = z
  .object({
    storeName: ledgerStoreNameSchema,
    purchaseDate: ledgerDateSchema
  })
  .strict();

export type LedgerPdfSelectionItem = z.output<typeof ledgerPdfSelectionItemSchema>;

/** 日期范围与离散日期二选一；语义校验（组合合法性、上限）留给交付服务保持原错误码。 */
export const ledgerCoverageScopeSchema = z
  .object({
    storeNames: z.array(ledgerStoreNameSchema).optional(),
    dates: z.array(ledgerDateSchema).optional(),
    startDate: ledgerDateSchema.optional(),
    endDate: ledgerDateSchema.optional()
  })
  .strict();

export type LedgerCoverageScope = z.output<typeof ledgerCoverageScopeSchema>;

export const ledgerCoverageBodySchema = z
  .object({
    scope: ledgerCoverageScopeSchema.optional(),
    selection: z.array(ledgerPdfSelectionItemSchema).optional(),
    cursor: z.string().optional()
  })
  .strict();

export type LedgerCoverageBody = z.output<typeof ledgerCoverageBodySchema>;

export const ledgerCoveragePartitionSchema = z
  .object({
    storeName: z.string().min(1),
    purchaseDate: z.string().min(1),
    status: z.enum(["ready", "pending", "stale", "missing"]),
    byteSize: z.number().int().positive().nullable()
  })
  .strict();

export const ledgerCoverageResponseSchema = z
  .object({
    partitions: z.array(ledgerCoveragePartitionSchema),
    nextCursor: z.string().nullable()
  })
  .strict();

export type LedgerCoverageResponse = z.output<typeof ledgerCoverageResponseSchema>;

export const ledgerPdfQuerySchema = z
  .object({
    storeName: ledgerStoreNameSchema,
    purchaseDate: ledgerDateSchema,
    disposition: z.enum(["inline", "attachment"])
  })
  .strict();

export type LedgerPdfQuery = z.output<typeof ledgerPdfQuerySchema>;

/**
 * PDF 以原始字节流返回（同源 iframe/下载直连），没有 JSON 响应体。
 * JSON Schema 无法表达二进制流，因此契约只记录“成功即一条可读流”；
 * 消费方按 Content-Type/Content-Disposition 处理，不得把它当 JSON 客户端响应。
 */
export const ledgerPdfResponseSchema = z.custom<Readable>((value) => value instanceof Readable, {
  message: "ledger pdf response must be a readable stream"
});

export const ledgerDownloadsBodySchema = z
  .object({
    selection: z.array(ledgerPdfSelectionItemSchema),
    idempotencyKey: z.string().min(1).max(255)
  })
  .strict();

export type LedgerDownloadsBody = z.output<typeof ledgerDownloadsBodySchema>;

export const ledgerDownloadsResponseSchema = z
  .object({
    requestId: z.string().min(1),
    status: z.string().min(1)
  })
  .strict();

export type LedgerDownloadsResponse = z.output<typeof ledgerDownloadsResponseSchema>;

export const ledgerRequestParamsSchema = z
  .object({
    requestId: z.string().min(1).max(128)
  })
  .strict();

export type LedgerRequestParams = z.output<typeof ledgerRequestParamsSchema>;

export const ledgerRequestQuerySchema = z
  .object({
    cursor: z.string().optional()
  })
  .strict();

export type LedgerRequestQuery = z.output<typeof ledgerRequestQuerySchema>;

/** 浏览器只能读到本人下载任务；刷新任务与管理员越权都在交付层按 404 拒绝。 */
export const ledgerRequestPartitionSchema = z
  .object({
    storeName: z.string().min(1),
    purchaseDate: z.string().min(1),
    status: z.string().min(1)
  })
  .strict();

export const ledgerRequestStatusResponseSchema = z
  .object({
    requestId: z.string().min(1),
    status: z.string().min(1),
    errorCode: z.string().min(1).optional(),
    partitions: z.array(ledgerRequestPartitionSchema),
    nextCursor: z.string().nullable()
  })
  .strict();

export type LedgerRequestStatusResponse = z.output<typeof ledgerRequestStatusResponseSchema>;

export const ledgerDownloadUrlResponseSchema = z
  .object({
    requestId: z.string().min(1),
    downloadUrl: z.url(),
    expiresAt: z.string().min(1),
    byteSize: z.number().int().min(1),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();

export type LedgerDownloadUrlResponse = z.output<typeof ledgerDownloadUrlResponseSchema>;
