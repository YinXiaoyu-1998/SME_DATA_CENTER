import { defineWebApiRoute, type WebApiRoute } from "../route-types.js";
import {
  ledgerContextResponseSchema,
  ledgerCoverageBodySchema,
  ledgerCoverageResponseSchema,
  ledgerDownloadUrlResponseSchema,
  ledgerDownloadsBodySchema,
  ledgerDownloadsResponseSchema,
  ledgerEmptyQuerySchema,
  ledgerPdfQuerySchema,
  ledgerPdfResponseSchema,
  ledgerRequestParamsSchema,
  ledgerRequestQuerySchema,
  ledgerRequestStatusResponseSchema
} from "../schemas/ledger.js";

/**
 * 台账下载中心的浏览器接口。
 *
 * 内容授权由交付服务按本人当前业务授权裁决：无权时列表为空、单条/打包按 404 隐藏，
 * 不在此处改成 403；这样既保留原有语义，也不额外泄露分区是否存在。
 */
export const ledgerWebApiRoutes: readonly WebApiRoute[] = Object.freeze([
  defineWebApiRoute({
    id: "ledger.context",
    method: "GET",
    path: "/api/web/v1/ledger/context",
    auth: "session",
    response: ledgerContextResponseSchema,
    errors: ["BROWSER_SIGN_IN_REQUIRED", "INTERNAL_ERROR"],
    summary: "读取台账下载中心所需的本人身份、CSRF 令牌与静态限额"
  }),
  defineWebApiRoute({
    id: "ledger.coverage",
    method: "POST",
    path: "/api/web/v1/ledger/coverage",
    auth: "session-write",
    query: ledgerEmptyQuerySchema,
    body: ledgerCoverageBodySchema,
    response: ledgerCoverageResponseSchema,
    errors: [
      "BROWSER_SIGN_IN_REQUIRED",
      "BROWSER_SECURITY_CHECK_FAILED",
      "WEB_API_INVALID_REQUEST",
      "LEDGER_SCOPE_INVALID",
      "LEDGER_SCOPE_LIMIT_EXCEEDED",
      "LEDGER_CURSOR_INVALID",
      "LEDGER_PDF_UNAVAILABLE",
      "LEDGER_PDF_NOT_ENABLED",
      "INTERNAL_ERROR"
    ],
    summary: "按日期范围或精确分区选择读取台账 PDF 覆盖、大小与下一页游标"
  }),
  defineWebApiRoute({
    id: "ledger.pdf",
    method: "GET",
    path: "/api/web/v1/ledger/pdf",
    auth: "session",
    query: ledgerPdfQuerySchema,
    response: ledgerPdfResponseSchema,
    errors: [
      "BROWSER_SIGN_IN_REQUIRED",
      "WEB_API_INVALID_REQUEST",
      "LEDGER_SCOPE_INVALID",
      "LEDGER_PDF_UNAVAILABLE",
      "LEDGER_PDF_NOT_READY",
      "LEDGER_PDF_BUNDLE_STALE",
      "LEDGER_PDF_NOT_ENABLED",
      "INTERNAL_ERROR"
    ],
    summary: "以同源流式响应预览或下载单个台账 PDF（非 JSON）"
  }),
  defineWebApiRoute({
    id: "ledger.downloads",
    method: "POST",
    path: "/api/web/v1/ledger/downloads",
    auth: "session-write",
    query: ledgerEmptyQuerySchema,
    body: ledgerDownloadsBodySchema,
    response: ledgerDownloadsResponseSchema,
    errors: [
      "BROWSER_SIGN_IN_REQUIRED",
      "BROWSER_SECURITY_CHECK_FAILED",
      "WEB_API_INVALID_REQUEST",
      "LEDGER_SCOPE_INVALID",
      "LEDGER_SCOPE_LIMIT_EXCEEDED",
      "LEDGER_PDF_BUNDLE_LIMIT_EXCEEDED",
      "LEDGER_PDF_UNAVAILABLE",
      "LEDGER_PDF_NOT_READY",
      "LEDGER_IDEMPOTENCY_CONFLICT",
      "LEDGER_PDF_NOT_ENABLED",
      "INTERNAL_ERROR"
    ],
    summary: "按精确分区清单幂等提交台账 ZIP 制作任务"
  }),
  defineWebApiRoute({
    id: "ledger.requests.read",
    method: "GET",
    path: "/api/web/v1/ledger/requests/:requestId",
    auth: "session",
    params: ledgerRequestParamsSchema,
    query: ledgerRequestQuerySchema,
    response: ledgerRequestStatusResponseSchema,
    errors: [
      "BROWSER_SIGN_IN_REQUIRED",
      "WEB_API_INVALID_REQUEST",
      "LEDGER_REQUEST_INVALID",
      "LEDGER_CURSOR_INVALID",
      "LEDGER_PDF_UNAVAILABLE",
      "LEDGER_PDF_NOT_ENABLED",
      "INTERNAL_ERROR"
    ],
    summary: "轮询本人台账 ZIP 任务的进度与分区结果"
  }),
  defineWebApiRoute({
    id: "ledger.requests.downloadUrl",
    method: "POST",
    path: "/api/web/v1/ledger/requests/:requestId/download-url",
    auth: "session-write",
    query: ledgerEmptyQuerySchema,
    params: ledgerRequestParamsSchema,
    response: ledgerDownloadUrlResponseSchema,
    errors: [
      "BROWSER_SIGN_IN_REQUIRED",
      "BROWSER_SECURITY_CHECK_FAILED",
      "WEB_API_INVALID_REQUEST",
      "LEDGER_REQUEST_INVALID",
      "LEDGER_PDF_UNAVAILABLE",
      "LEDGER_PDF_NOT_READY",
      "LEDGER_PDF_BUNDLE_STALE",
      "LEDGER_DOWNLOAD_REBUILD_REQUIRED",
      "AUTHORIZATION_VERSION_CONFLICT",
      "LEDGER_PDF_NOT_ENABLED",
      "INTERNAL_ERROR"
    ],
    summary: "为已完成的本人台账 ZIP 重新签发短时下载链接"
  })
]);
