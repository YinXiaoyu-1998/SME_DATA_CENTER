import { defineWebApiRoute, type WebApiRoute } from "../route-types.js";
import {
  directoryInputSchemas,
  directoryOrgParams,
  directoryResponses
} from "../schemas/employee-directory.js";

const base = "/api/web/v1/orgs/:orgId/directory";
const errors = [
  "BROWSER_SIGN_IN_REQUIRED",
  "BROWSER_SECURITY_CHECK_FAILED",
  "BROWSER_ACCESS_DENIED",
  "WEB_API_INVALID_REQUEST",
  "DIRECTORY_ACCESS_DENIED",
  "DIRECTORY_NOT_FOUND",
  "DIRECTORY_CONFLICT",
  "DIRECTORY_IN_USE",
  "INTERNAL_ERROR"
] as const;
const summaries = {
  list_directory: "读取企业门店和部门目录",
  list_employees: "读取授权范围内的员工档案",
  get_employee: "读取授权范围内的单个员工档案",
  create_employee: "创建员工档案",
  update_employee: "维护员工档案与归属",
  manage_store: "维护正式门店目录",
  manage_department: "维护部门目录"
} as const;
export const employeeDirectoryWebApiRoutes: readonly WebApiRoute[] = Object.freeze(
  (Object.keys(summaries) as Array<keyof typeof summaries>).map((operation) =>
    defineWebApiRoute({
      id: `directory.${operation.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())}`,
      method: "POST",
      path: `${base}/${operation}`,
      auth: "session-write",
      params: directoryOrgParams,
      body: directoryInputSchemas[operation],
      response: directoryResponses[operation],
      errors,
      summary: summaries[operation]
    })
  )
);
