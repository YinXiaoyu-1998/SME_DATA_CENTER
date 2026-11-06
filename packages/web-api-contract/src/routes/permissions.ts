import { defineWebApiRoute, type WebApiRoute } from "../route-types.js";
import {
  permissionAccountParams,
  permissionAccountResponse,
  permissionAccountUpdateBody,
  permissionAccountUpdateResponse,
  permissionAccountsResponse,
  permissionCardResponse,
  permissionCategoriesResponse,
  permissionCategoryCreateBody,
  permissionCategoryInitializeResponse,
  permissionCategoryParams,
  permissionCategoryResponse,
  permissionCategoryUpdateBody,
  permissionCutoverBody,
  permissionCutoverModeResponse,
  permissionCutoverResponse,
  permissionDimensionCreateBody,
  permissionDimensionIdParams,
  permissionDimensionParams,
  permissionDimensionResponse,
  permissionDimensionUpdateBody,
  permissionDimensionValueCreateBody,
  permissionDimensionValueParams,
  permissionDimensionValueResponse,
  permissionDimensionValueUpdateBody,
  permissionDimensionsResponse,
  permissionDocumentParams,
  permissionDocumentQuery,
  permissionDocumentUpdateBody,
  permissionDocumentUpdateResponse,
  permissionDocumentsResponse,
  permissionEnterpriseDeclareBody,
  permissionEnterpriseDeclareResponse,
  permissionEnterprisePreviewBody,
  permissionEnterprisePreviewResponse,
  permissionEnterprisesResponse,
  permissionOrgParams,
  permissionStoreBody,
  permissionStoreResponse,
  permissionStoresResponse,
  permissionVersionBody
} from "../schemas/permissions.js";

const base = "/api/web/v1/orgs/:orgId/permissions";

/** 会话类读接口：未登录、越权与跨组织是本面的常态失败。 */
const read = [
  "BROWSER_SIGN_IN_REQUIRED",
  "BROWSER_ACCESS_DENIED",
  "AUTHORIZATION_ADMIN_REQUIRED",
  "INTERNAL_ERROR"
] as const;

/** 需要路径/查询参数的读接口额外声明入参校验码。 */
const readWithInput = [...read, "WEB_API_INVALID_REQUEST"] as const;

/** 会话写接口：同源 Origin 与 CSRF 是写校验，版本冲突整笔回滚。 */
const write = [
  "BROWSER_SIGN_IN_REQUIRED",
  "BROWSER_SECURITY_CHECK_FAILED",
  "BROWSER_ACCESS_DENIED",
  "AUTHORIZATION_ADMIN_REQUIRED",
  "AUTHORIZATION_VERSION_CONFLICT",
  "INVALID_PERMISSION_CONFIGURATION",
  "INTERNAL_ERROR"
] as const;

const writeWithInput = [...write, "WEB_API_INVALID_REQUEST"] as const;

export const permissionsWebApiRoutes: readonly WebApiRoute[] = Object.freeze([
  defineWebApiRoute({
    id: "permissions.me.read",
    method: "GET",
    path: `${base}/me`,
    auth: "session",
    params: permissionOrgParams,
    response: permissionCardResponse,
    errors: readWithInput,
    summary: "读取当前账号的权限卡片与可审核企业范围"
  }),
  defineWebApiRoute({
    id: "permissions.accounts.list",
    method: "GET",
    path: `${base}/accounts`,
    auth: "session",
    params: permissionOrgParams,
    response: permissionAccountsResponse,
    errors: readWithInput,
    summary: "列出同企业账号及其授权"
  }),
  defineWebApiRoute({
    id: "permissions.accounts.read",
    method: "GET",
    path: `${base}/accounts/:employeeId`,
    auth: "session",
    params: permissionAccountParams,
    response: permissionAccountResponse,
    errors: [...readWithInput, "AUTHORIZATION_ACCOUNT_NOT_FOUND"],
    summary: "读取单个账号的授权快照"
  }),
  defineWebApiRoute({
    id: "permissions.accounts.update",
    method: "PATCH",
    path: `${base}/accounts/:employeeId`,
    auth: "session-write",
    params: permissionAccountParams,
    body: permissionAccountUpdateBody,
    response: permissionAccountUpdateResponse,
    errors: [...writeWithInput, "AUTHORIZATION_ACCOUNT_NOT_FOUND", "ENTERPRISE_NAME_REQUIRED"],
    summary: "按期望版本保存账号密级与业务授权"
  }),
  defineWebApiRoute({
    id: "permissions.stores.list",
    method: "GET",
    path: `${base}/stores`,
    auth: "session",
    params: permissionOrgParams,
    response: permissionStoresResponse,
    errors: readWithInput,
    summary: "列出企业门店目录"
  }),
  defineWebApiRoute({
    id: "permissions.stores.upsert",
    method: "POST",
    path: `${base}/stores`,
    auth: "session-write",
    params: permissionOrgParams,
    body: permissionStoreBody,
    response: permissionStoreResponse,
    errors: [...writeWithInput, "ENTERPRISE_NAME_REQUIRED", "ENTERPRISE_NAME_CONFLICT"],
    summary: "按期望版本新增或更新门店"
  }),
  defineWebApiRoute({
    id: "permissions.categories.list",
    method: "GET",
    path: `${base}/categories`,
    auth: "session",
    params: permissionOrgParams,
    response: permissionCategoriesResponse,
    errors: readWithInput,
    summary: "列出业务类别及其必需维度"
  }),
  defineWebApiRoute({
    id: "permissions.categories.create",
    method: "POST",
    path: `${base}/categories`,
    auth: "session-write",
    params: permissionOrgParams,
    body: permissionCategoryCreateBody,
    response: permissionCategoryResponse,
    errors: writeWithInput,
    summary: "新建证据类别"
  }),
  defineWebApiRoute({
    id: "permissions.categories.update",
    method: "PATCH",
    path: `${base}/categories/:id`,
    auth: "session-write",
    params: permissionCategoryParams,
    body: permissionCategoryUpdateBody,
    response: permissionCategoryResponse,
    errors: [...writeWithInput, "CATEGORY_NOT_FOUND"],
    summary: "更新固定类别密级或证据类别配置"
  }),
  defineWebApiRoute({
    id: "permissions.categories.initialize",
    method: "POST",
    path: `${base}/categories/initialize`,
    auth: "session-write",
    params: permissionOrgParams,
    body: permissionVersionBody,
    response: permissionCategoryInitializeResponse,
    errors: writeWithInput,
    summary: "按期望版本初始化固定业务类别"
  }),
  defineWebApiRoute({
    id: "permissions.dimensions.list",
    method: "GET",
    path: `${base}/dimensions`,
    auth: "session",
    params: permissionOrgParams,
    response: permissionDimensionsResponse,
    errors: readWithInput,
    summary: "列出业务维度及其取值"
  }),
  defineWebApiRoute({
    id: "permissions.dimensions.create",
    method: "POST",
    path: `${base}/dimensions`,
    auth: "session-write",
    params: permissionOrgParams,
    body: permissionDimensionCreateBody,
    response: permissionDimensionResponse,
    errors: writeWithInput,
    summary: "新建业务维度"
  }),
  defineWebApiRoute({
    id: "permissions.dimensions.update",
    method: "PATCH",
    path: `${base}/dimensions/:id`,
    auth: "session-write",
    params: permissionDimensionIdParams,
    body: permissionDimensionUpdateBody,
    response: permissionDimensionResponse,
    errors: writeWithInput,
    summary: "更新业务维度名称与停用状态"
  }),
  defineWebApiRoute({
    id: "permissions.dimensions.valueCreate",
    method: "POST",
    path: `${base}/dimensions/:dimensionId/values`,
    auth: "session-write",
    params: permissionDimensionParams,
    body: permissionDimensionValueCreateBody,
    response: permissionDimensionValueResponse,
    errors: writeWithInput,
    summary: "在维度下新建取值"
  }),
  defineWebApiRoute({
    id: "permissions.dimensions.valueUpdate",
    method: "PATCH",
    path: `${base}/dimensions/:dimensionId/values/:id`,
    auth: "session-write",
    params: permissionDimensionValueParams,
    body: permissionDimensionValueUpdateBody,
    response: permissionDimensionValueResponse,
    errors: writeWithInput,
    summary: "更新维度取值的名称与停用状态"
  }),
  defineWebApiRoute({
    id: "permissions.documents.list",
    method: "GET",
    path: `${base}/documents`,
    auth: "session",
    params: permissionOrgParams,
    query: permissionDocumentQuery,
    response: permissionDocumentsResponse,
    errors: readWithInput,
    summary: "分页检索证据文档及其授权属性"
  }),
  defineWebApiRoute({
    id: "permissions.documents.update",
    method: "PATCH",
    path: `${base}/documents/:documentId`,
    auth: "session-write",
    params: permissionDocumentParams,
    body: permissionDocumentUpdateBody,
    response: permissionDocumentUpdateResponse,
    errors: [...writeWithInput, "RESOURCE_NOT_FOUND"],
    summary: "按期望版本保存证据文档的类别、密级与作用域"
  }),
  defineWebApiRoute({
    id: "permissions.enterprises.list",
    method: "GET",
    path: `${base}/enterprises`,
    auth: "session",
    params: permissionOrgParams,
    response: permissionEnterprisesResponse,
    errors: readWithInput,
    summary: "列出已登记的业务企业"
  }),
  defineWebApiRoute({
    id: "permissions.enterprises.declare",
    method: "POST",
    path: `${base}/enterprises`,
    auth: "session-write",
    params: permissionOrgParams,
    body: permissionEnterpriseDeclareBody,
    response: permissionEnterpriseDeclareResponse,
    errors: [...writeWithInput, "INVALID_ENTERPRISE_NAME", "ENTERPRISE_NAME_CONFLICT"],
    summary: "按期望版本登记业务企业名称"
  }),
  defineWebApiRoute({
    id: "permissions.enterprises.preview",
    method: "POST",
    path: `${base}/enterprises/preview`,
    auth: "session-write",
    params: permissionOrgParams,
    body: permissionEnterprisePreviewBody,
    response: permissionEnterprisePreviewResponse,
    errors: [...writeWithInput, "INVALID_ENTERPRISE_NAME"],
    summary: "只计算企业名称的规范化标识，不落库"
  }),
  defineWebApiRoute({
    id: "permissions.cutover.read",
    method: "GET",
    path: `${base}/cutover`,
    auth: "session",
    params: permissionOrgParams,
    response: permissionCutoverResponse,
    errors: readWithInput,
    summary: "检查业务授权启用前的准备项"
  }),
  defineWebApiRoute({
    id: "permissions.cutover.activate",
    method: "POST",
    path: `${base}/cutover/activate`,
    auth: "session-write",
    params: permissionOrgParams,
    body: permissionCutoverBody,
    response: permissionCutoverModeResponse,
    errors: [...writeWithInput, "AUTHORIZATION_CUTOVER_NOT_READY", "AUTHORIZATION_SUSPENDED"],
    summary: "按期望版本并显式确认后启用业务授权"
  }),
  defineWebApiRoute({
    id: "permissions.cutover.suspend",
    method: "POST",
    path: `${base}/cutover/suspend`,
    auth: "session-write",
    params: permissionOrgParams,
    body: permissionCutoverBody,
    response: permissionCutoverModeResponse,
    errors: [...writeWithInput, "AUTHORIZATION_NOT_ENABLED"],
    summary: "按期望版本并显式确认后暂停业务授权读取"
  })
]);
