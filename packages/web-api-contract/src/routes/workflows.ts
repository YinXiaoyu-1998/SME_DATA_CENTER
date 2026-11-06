import { defineWebApiRoute, type WebApiRoute } from "../route-types.js";
import {
  workflowActionBody,
  workflowActionResponse,
  workflowGetBody,
  workflowGetResponse,
  workflowInstallationBody,
  workflowInstallationResponse,
  workflowListBody,
  workflowListResponse,
  workflowOrgParams,
  workflowPrepareBody,
  workflowPrepareResponse,
  workflowRunBody,
  workflowRunResponse,
  workflowSaveBody,
  workflowSaveResponse,
  workflowStatusBody,
  workflowStatusResponse
} from "../schemas/workflows.js";

const base = "/api/web/v1/orgs/:orgId/workflows";

/**
 * 自动任务面只服务同企业管理员，且每个工具都会写审计。
 * 错误码沿用服务层原样抛出的 WORKFLOW_* / ORDER_SCOPE_*，不在路由层改写。
 */
const errors = [
  "BROWSER_SIGN_IN_REQUIRED",
  "BROWSER_SECURITY_CHECK_FAILED",
  "BROWSER_ACCESS_DENIED",
  "WEB_API_INVALID_REQUEST",
  "AUTHORIZATION_ADMIN_REQUIRED",
  "WORKFLOW_ADMIN_REQUIRED",
  "WORKFLOW_PERMISSION_DENIED",
  "WORKFLOW_CONFIGURATION_REQUIRED",
  "WORKFLOW_VERSION_CONFLICT",
  "WORKFLOW_VERSION_INCOMPATIBLE",
  "WORKFLOW_SOURCE_MAPPING_CONFLICT",
  "WORKFLOW_INSTALLATION_MISMATCH",
  "WORKFLOW_CONTROL_REVOKED",
  "WORKFLOW_BUSY",
  "WORKFLOW_ACTION_UNKNOWN",
  "WORKFLOW_SOURCE_UNAVAILABLE",
  "INTERNAL_ERROR"
] as const;

export const workflowsWebApiRoutes: readonly WebApiRoute[] = Object.freeze([
  defineWebApiRoute({
    id: "workflows.listEnterpriseWorkflows",
    method: "POST",
    path: `${base}/list_enterprise_workflows`,
    auth: "session-write",
    params: workflowOrgParams,
    body: workflowListBody,
    response: workflowListResponse,
    errors,
    summary: "列出企业下的自动任务与配置缺口"
  }),
  defineWebApiRoute({
    id: "workflows.getEnterpriseWorkflow",
    method: "POST",
    path: `${base}/get_enterprise_workflow`,
    auth: "session-write",
    params: workflowOrgParams,
    body: workflowGetBody,
    response: workflowGetResponse,
    errors,
    summary: "读取单个自动任务的配置、来源与授权"
  }),
  defineWebApiRoute({
    id: "workflows.prepareEnterpriseWorkflowChange",
    method: "POST",
    path: `${base}/prepare_enterprise_workflow_change`,
    auth: "session-write",
    params: workflowOrgParams,
    body: workflowPrepareBody,
    response: workflowPrepareResponse,
    errors,
    summary: "准备一次配置、来源、授权或控制状态变更并返回确认摘要"
  }),
  defineWebApiRoute({
    id: "workflows.saveEnterpriseWorkflow",
    method: "POST",
    path: `${base}/save_enterprise_workflow`,
    auth: "session-write",
    params: workflowOrgParams,
    body: workflowSaveBody,
    response: workflowSaveResponse,
    errors,
    summary: "按预览摘要提交自动任务变更"
  }),
  defineWebApiRoute({
    id: "workflows.manageWorkflowInstallation",
    method: "POST",
    path: `${base}/manage_workflow_installation`,
    auth: "session-write",
    params: workflowOrgParams,
    body: workflowInstallationBody,
    response: workflowInstallationResponse,
    errors,
    summary: "登记主机、记录就绪检查、切换接管或迁移任务"
  }),
  defineWebApiRoute({
    id: "workflows.manageWorkflowRun",
    method: "POST",
    path: `${base}/manage_workflow_run`,
    auth: "session-write",
    params: workflowOrgParams,
    body: workflowRunBody,
    response: workflowRunResponse,
    errors,
    summary: "开始、续租、释放、结束一次运行或校验动作许可"
  }),
  defineWebApiRoute({
    id: "workflows.recordWorkflowAction",
    method: "POST",
    path: `${base}/record_workflow_action`,
    auth: "session-write",
    params: workflowOrgParams,
    body: workflowActionBody,
    response: workflowActionResponse,
    errors,
    summary: "读取动作库存、登记动作意图或登记可信回执"
  }),
  defineWebApiRoute({
    id: "workflows.getWorkflowStatus",
    method: "POST",
    path: `${base}/get_workflow_status`,
    auth: "session-write",
    params: workflowOrgParams,
    body: workflowStatusBody,
    response: workflowStatusResponse,
    errors,
    summary: "读取运行窗口、未决动作、安装与迁移分页"
  })
]);
