import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  normalizeEnterpriseIdentity,
  validateBusinessGrant,
  validateBusinessScope,
  type BusinessGrant,
  type BusinessScopeItem
} from "@smedc/domain";
import { WORKFLOW_OPERATION_NAMES, type WorkflowOperationInputs } from "@smedc/mcp-contract";
import {
  getWebApiRoute,
  permissionAccountUpdateBody,
  permissionCategoryCreateBody,
  permissionCategoryUpdateBody,
  permissionCutoverBody,
  permissionDimensionCreateBody,
  permissionDimensionUpdateBody,
  permissionDimensionValueCreateBody,
  permissionDocumentQuery,
  permissionDocumentUpdateBody,
  permissionEnterpriseDeclareBody,
  permissionEnterprisePreviewBody,
  permissionStoreBody,
  permissionVersionBody,
  webApiErrorBody
} from "@smedc/web-api-contract";
import type { AuthCore } from "../auth/auth-core.js";
import {
  BROWSER_SESSION_COOKIE,
  type BrowserPrincipal,
  type BrowserSessions
} from "../auth/browser-session.js";
import { cookieValue, matchesCsrfToken } from "../auth/http-contract.js";
import type { BusinessAuthorizationService } from "../business-authorization.js";
import { respondBusinessAuthorizationError } from "../routes/business-authorization.js";
import type { EnterpriseWorkflowService } from "../enterprise-workflows/service.js";
import { registerWebApiRoute, type WebApiContext } from "../web-api/register.js";
import type { PermissionsUiMetadata } from "./metadata.js";

export interface AdminPermissionsRoutesOptions {
  /** 登录本身已迁到会话接口，这里只保留构造参数以便装配层不变。 */
  auth: Pick<AuthCore, "verifyLogin">;
  browserSessions: BrowserSessions;
  permissions: () => BusinessAuthorizationService;
  metadata: () => PermissionsUiMetadata;
  webOrigin: string;
  workflows?: () => EnterpriseWorkflowService;
}

const MESSAGES: Record<string, string> = {
  BROWSER_ACCESS_DENIED: "当前账号无权访问该企业的权限设置。",
  INVALID_PERMISSION_CONFIGURATION: "权限配置无效。",
  CATEGORY_NOT_FOUND: "业务类别不存在。",
  INVALID_ENTERPRISE_NAME: "企业名称无效。"
};

const fail = (reply: FastifyReply, status: number, code: string) =>
  reply.code(status).send(webApiErrorBody(code, MESSAGES[code] ?? "请求无法完成，请刷新后重试。"));

/** Prisma 的 bigint 与 Date 在 Fastify 序列化前先归一，响应契约校验看到的就是线上形状。 */
function jsonSafe(value: unknown): unknown {
  if (value === undefined) return value;
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item
    )
  );
}

const workflowRouteIds: Record<keyof WorkflowOperationInputs, string> = {
  list_enterprise_workflows: "workflows.listEnterpriseWorkflows",
  get_enterprise_workflow: "workflows.getEnterpriseWorkflow",
  prepare_enterprise_workflow_change: "workflows.prepareEnterpriseWorkflowChange",
  save_enterprise_workflow: "workflows.saveEnterpriseWorkflow",
  manage_workflow_installation: "workflows.manageWorkflowInstallation",
  manage_workflow_run: "workflows.manageWorkflowRun",
  record_workflow_action: "workflows.recordWorkflowAction",
  get_workflow_status: "workflows.getWorkflowStatus"
};

/**
 * 企业内管理员面的浏览器接口。
 * 会话来自共享浏览器 Cookie，写校验是同源 Origin + CSRF；组织与角色取自会话而不是 URL。
 */
export function registerAdminPermissionsRoutes(
  app: FastifyInstance,
  options: AdminPermissionsRoutesOptions
): void {
  const sharedSecret = (request: FastifyRequest) =>
    cookieValue(request.headers.cookie, BROWSER_SESSION_COOKIE);
  const authenticate = async (request: FastifyRequest) =>
    options.browserSessions.authenticate(sharedSecret(request));
  const verifyWrite = (request: FastifyRequest, principal: BrowserPrincipal | null): boolean => {
    if (request.headers.origin !== options.webOrigin || principal === null) return false;
    const secret = sharedSecret(request);
    const csrf = request.headers["x-csrf-token"];
    return secret !== null && typeof csrf === "string" && matchesCsrfToken(secret, csrf);
  };
  // URL 只用来定位企业：跨组织与普通员工一律 403，且不返回对方任何元数据。
  const tenantAdmin = (principal: BrowserPrincipal, orgId: string) =>
    principal.orgId === orgId && principal.role === "admin";
  const orgIdOf = (params: Record<string, unknown>) => String(params["orgId"] ?? "");

  interface PermissionContext {
    principal: BrowserPrincipal;
    orgId: string;
    params: Record<string, unknown>;
    query: Record<string, unknown>;
    body: unknown;
    reply: FastifyReply;
  }

  function permissionRoute(
    id: string,
    handler: (context: PermissionContext) => Promise<unknown>
  ): void {
    registerWebApiRoute<BrowserPrincipal>(app, getWebApiRoute(id), {
      authenticate,
      verifyWrite,
      handler: async (context: WebApiContext<BrowserPrincipal>) => {
        const principal = context.principal;
        if (!principal) throw new Error(`route ${id} requires a session`);
        const orgId = orgIdOf(context.params);
        if (!tenantAdmin(principal, orgId)) {
          fail(context.reply, 403, "BROWSER_ACCESS_DENIED");
          return null;
        }
        try {
          const result = await handler({
            principal,
            orgId,
            params: context.params,
            query: context.query,
            body: context.body,
            reply: context.reply
          });
          // 已发出的错误响应不再参与成功契约校验。
          return context.reply.sent ? null : jsonSafe(result);
        } catch (error) {
          return respondBusinessAuthorizationError(error, context.reply);
        }
      }
    });
  }

  const service = () => options.permissions();
  /** 写入口统一先取当前快照：它同时完成账号可用性与管理员校验。 */
  const current = (context: PermissionContext) =>
    service().current({ id: context.principal.id, orgId: context.orgId }, true);

  permissionRoute("permissions.me.read", async ({ principal, orgId }) => {
    const card = await service().permissionCard({ id: principal.id, orgId });
    return {
      ...card,
      categories: card.categories.filter((category) =>
        card.grants.some((grant) => grant.categoryIds.includes(category.id))
      )
    };
  });

  permissionRoute("permissions.accounts.list", async (context) => {
    const actor = await current(context);
    return {
      accounts: await service().repository.listAccounts(actor.orgId, actor.userAccountId)
    };
  });

  permissionRoute("permissions.accounts.read", async (context) => {
    const actor = await current(context);
    return service().repository.loadAuthorizationSnapshot(
      String(context.params["userAccountId"]),
      actor.orgId
    );
  });

  permissionRoute("permissions.accounts.update", async (context) => {
    const actor = await current(context);
    const body = permissionAccountUpdateBody.parse(context.body);
    const grants = body.grants as BusinessGrant[];
    if (
      grants.some(
        (grant) =>
          grant.orgId !== actor.orgId || validateBusinessGrant(grant, actor.categories).length > 0
      )
    )
      return fail(context.reply, 400, "INVALID_PERMISSION_CONFIGURATION");
    return service().repository.configureAccount({
      orgId: actor.orgId,
      actorId: actor.userAccountId,
      userAccountId: String(context.params["userAccountId"]),
      expectedVersion: body.expectedVersion,
      clearance: body.clearance,
      grants
    });
  });

  permissionRoute("permissions.stores.list", async (context) => {
    const actor = await current(context);
    return {
      authorizationVersion: actor.authorizationVersion,
      stores: await service().repository.listStores(actor.orgId)
    };
  });

  permissionRoute("permissions.stores.upsert", async (context) => {
    const actor = await current(context);
    const body = permissionStoreBody.parse(context.body);
    return service().repository.putStore({
      orgId: actor.orgId,
      actorId: actor.userAccountId,
      expectedVersion: body.expectedVersion,
      ...(body.enterpriseKey !== undefined ? { enterpriseKey: body.enterpriseKey } : {}),
      ...(body.enterpriseName !== undefined ? { enterpriseName: body.enterpriseName } : {}),
      name: body.name,
      ...(body.retired !== undefined ? { retired: body.retired } : {})
    });
  });

  permissionRoute("permissions.categories.list", async (context) => {
    const actor = await current(context);
    return {
      authorizationVersion: actor.authorizationVersion,
      categories: await service().repository.listCategories(actor.orgId)
    };
  });

  permissionRoute("permissions.categories.create", async (context) => {
    const actor = await current(context);
    const body = permissionCategoryCreateBody.parse(context.body);
    return service().repository.configureCategory({
      orgId: actor.orgId,
      actorId: actor.userAccountId,
      expectedVersion: body.expectedVersion,
      id: body.id,
      name: body.name,
      kind: "evidence",
      confidentialityLevel: null,
      ownerships: body.ownerships,
      requiredDimensionIds: body.requiredDimensionIds,
      createOnly: true,
      ...(body.retired !== undefined ? { retired: body.retired } : {})
    });
  });

  permissionRoute("permissions.categories.update", async (context) => {
    const actor = await current(context);
    const body = permissionCategoryUpdateBody.parse(context.body);
    const id = String(context.params["id"]);
    const existing = (await service().repository.listCategories(actor.orgId)).find(
      (category) => category.id === id
    );
    if (!existing) return fail(context.reply, 404, "CATEGORY_NOT_FOUND");
    const shared = {
      orgId: actor.orgId,
      actorId: actor.userAccountId,
      expectedVersion: body.expectedVersion,
      id,
      name: body.name,
      ...(body.retired !== undefined ? { retired: body.retired } : {})
    };
    // 固定类别只允许调密级；证据类别只允许调归属与必需维度。
    if (existing.kind === "fixed") {
      if (!("confidentialityLevel" in body))
        return fail(context.reply, 400, "INVALID_PERMISSION_CONFIGURATION");
      return service().repository.configureCategory({
        ...shared,
        kind: "fixed",
        key: existing.key!,
        confidentialityLevel: body.confidentialityLevel,
        ownerships: [existing.allowStore ? "store" : "group"],
        requiredDimensionIds: existing.dimensions.map((dimension) => dimension.dimensionId)
      });
    }
    if (!("ownerships" in body))
      return fail(context.reply, 400, "INVALID_PERMISSION_CONFIGURATION");
    return service().repository.configureCategory({
      ...shared,
      kind: "evidence",
      confidentialityLevel: null,
      ownerships: body.ownerships,
      requiredDimensionIds: body.requiredDimensionIds,
      createOnly: false
    });
  });

  permissionRoute("permissions.categories.initialize", async (context) => {
    const actor = await current(context);
    const body = permissionVersionBody.parse(context.body);
    return service().repository.initializeFixedCategories({
      orgId: actor.orgId,
      actorId: actor.userAccountId,
      expectedVersion: body.expectedVersion
    });
  });

  permissionRoute("permissions.dimensions.list", async (context) => {
    const actor = await current(context);
    return {
      authorizationVersion: actor.authorizationVersion,
      dimensions: await service().repository.listDimensions(actor.orgId)
    };
  });

  permissionRoute("permissions.dimensions.create", async (context) => {
    const actor = await current(context);
    const body = permissionDimensionCreateBody.parse(context.body);
    return service().repository.defineDimension({
      orgId: actor.orgId,
      actorId: actor.userAccountId,
      expectedVersion: body.expectedVersion,
      id: body.id,
      name: body.name,
      createOnly: true,
      updateOnly: false,
      ...(body.retired !== undefined ? { retired: body.retired } : {})
    });
  });

  permissionRoute("permissions.dimensions.update", async (context) => {
    const actor = await current(context);
    const body = permissionDimensionUpdateBody.parse(context.body);
    return service().repository.defineDimension({
      orgId: actor.orgId,
      actorId: actor.userAccountId,
      expectedVersion: body.expectedVersion,
      id: String(context.params["id"]),
      name: body.name,
      createOnly: false,
      updateOnly: true,
      ...(body.retired !== undefined ? { retired: body.retired } : {})
    });
  });

  permissionRoute("permissions.dimensions.valueCreate", async (context) => {
    const actor = await current(context);
    const body = permissionDimensionValueCreateBody.parse(context.body);
    return service().repository.defineDimensionValue({
      orgId: actor.orgId,
      actorId: actor.userAccountId,
      expectedVersion: body.expectedVersion,
      id: body.id,
      dimensionId: String(context.params["dimensionId"]),
      name: body.name,
      createOnly: true,
      updateOnly: false,
      ...(body.retired !== undefined ? { retired: body.retired } : {})
    });
  });

  permissionRoute("permissions.dimensions.valueUpdate", async (context) => {
    const actor = await current(context);
    const body = permissionDimensionUpdateBody.parse(context.body);
    return service().repository.defineDimensionValue({
      orgId: actor.orgId,
      actorId: actor.userAccountId,
      expectedVersion: body.expectedVersion,
      id: String(context.params["id"]),
      dimensionId: String(context.params["dimensionId"]),
      name: body.name,
      createOnly: false,
      updateOnly: true,
      ...(body.retired !== undefined ? { retired: body.retired } : {})
    });
  });

  permissionRoute("permissions.documents.list", async (context) => {
    const actor = await current(context);
    const query = permissionDocumentQuery.parse(context.query);
    return {
      authorizationVersion: actor.authorizationVersion,
      ...(await options.metadata().listDocuments(actor.orgId, {
        ...(query.search ? { search: query.search } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {})
      }))
    };
  });

  permissionRoute("permissions.documents.update", async (context) => {
    const actor = await current(context);
    const body = permissionDocumentUpdateBody.parse(context.body);
    const category = actor.categories.find(
      (rule) => rule.id === body.categoryId && rule.kind === "evidence"
    );
    if (!category || !body.scopes.every((scope) => validateBusinessScope(scope, category)))
      return fail(context.reply, 400, "INVALID_PERMISSION_CONFIGURATION");
    return service().repository.configureEvidenceDocument({
      orgId: actor.orgId,
      actorId: actor.userAccountId,
      expectedVersion: body.expectedVersion,
      documentId: String(context.params["documentId"]),
      categoryId: body.categoryId,
      fileConfidentialityLevel: body.fileConfidentialityLevel,
      scopes: body.scopes as BusinessScopeItem[],
      ...(body.historicalSupplementReason !== undefined
        ? { historicalSupplementReason: body.historicalSupplementReason }
        : {})
    });
  });

  permissionRoute("permissions.enterprises.list", async (context) => {
    const actor = await current(context);
    return {
      authorizationVersion: actor.authorizationVersion,
      enterprises: await options.metadata().listEnterprises(actor.orgId)
    };
  });

  permissionRoute("permissions.enterprises.declare", async (context) => {
    const actor = await current(context);
    const body = permissionEnterpriseDeclareBody.parse(context.body);
    return service().repository.declareEnterpriseIdentity({
      orgId: actor.orgId,
      actorId: actor.userAccountId,
      expectedVersion: body.expectedVersion,
      name: body.name
    });
  });

  permissionRoute("permissions.enterprises.preview", async (context) => {
    await current(context);
    const body = permissionEnterprisePreviewBody.parse(context.body);
    const identity = normalizeEnterpriseIdentity(body.name);
    if (identity.enterpriseKey.length > 128)
      return fail(context.reply, 400, "INVALID_ENTERPRISE_NAME");
    return identity;
  });

  permissionRoute("permissions.cutover.read", async (context) => {
    const actor = await current(context);
    return service().prepareAuthorizationCutover(actor.orgId);
  });

  permissionRoute("permissions.cutover.activate", async (context) => {
    const actor = await current(context);
    const body = permissionCutoverBody.parse(context.body);
    return service().activateAuthorizationCutover(actor, body.expectedVersion, true);
  });

  permissionRoute("permissions.cutover.suspend", async (context) => {
    const actor = await current(context);
    const body = permissionCutoverBody.parse(context.body);
    return service().repository.suspendAuthorizationReads({
      orgId: actor.orgId,
      actorId: actor.userAccountId,
      expectedVersion: body.expectedVersion,
      confirm: true
    });
  });

  if (!options.workflows) return;
  const workflows = options.workflows;
  for (const tool of WORKFLOW_OPERATION_NAMES) {
    registerWebApiRoute<BrowserPrincipal>(app, getWebApiRoute(workflowRouteIds[tool]), {
      authenticate,
      verifyWrite,
      handler: async ({ principal, params, body, reply }) => {
        if (!principal) throw new Error(`route for ${tool} requires a session`);
        const orgId = orgIdOf(params);
        if (!tenantAdmin(principal, orgId)) {
          fail(reply, 403, "BROWSER_ACCESS_DENIED");
          return null;
        }
        try {
          // 服务层继续负责管理员复核、版本校验与审计归属。
          const result = await workflows().execute(
            tool,
            body as WorkflowOperationInputs[typeof tool],
            {
              id: principal.id,
              orgId
            }
          );
          return jsonSafe(result);
        } catch (error) {
          return respondWorkflowError(error, reply);
        }
      }
    });
  }
}

/** 自动任务错误码映射与服务层一致：权限 403、配置缺失 404、其余状态冲突 409。 */
function respondWorkflowError(error: unknown, reply: FastifyReply) {
  const code = error instanceof Error ? error.message : "";
  if (code.startsWith("WORKFLOW_"))
    return fail(
      reply,
      /ADMIN_REQUIRED|PERMISSION_DENIED/.test(code)
        ? 403
        : /CONFIGURATION_REQUIRED/.test(code)
          ? 404
          : 409,
      code
    );
  if (
    typeof error === "object" &&
    error &&
    "code" in error &&
    ["P2002", "P2034"].includes(String(error.code))
  )
    return fail(reply, 409, "WORKFLOW_VERSION_CONFLICT");
  throw error;
}
