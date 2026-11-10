import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { directoryInputSchemas } from "@smedc/mcp-contract";
import { errorResponse } from "../request-errors.js";
import type { RequestAuth } from "../request-auth.js";
import type { createEmployeeDirectoryService } from "./service.js";

type Service = ReturnType<typeof createEmployeeDirectoryService>;
export function registerEmployeeDirectoryRoutes(
  app: FastifyInstance,
  dependencies: { auth: Pick<RequestAuth, "authenticate" | "employee">; directory: () => Service }
) {
  for (const action of Object.keys(directoryInputSchemas) as Array<
    keyof typeof directoryInputSchemas
  >) {
    app.post(`/v1/directory/${action}`, async (request, reply) => {
      if (!(await dependencies.auth.authenticate(request, reply))) return;
      try {
        return await dependencies
          .directory()
          .execute(action, request.body, dependencies.auth.employee(request));
      } catch (error) {
        if (error instanceof ZodError)
          return reply
            .code(400)
            .send(errorResponse("DIRECTORY_INVALID_REQUEST", "Invalid directory request."));
        const code = error instanceof Error ? error.message : "";
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          ["P2002", "P2034"].includes(String(error.code))
        )
          return reply
            .code(409)
            .send(errorResponse("DIRECTORY_CONFLICT", "Directory item changed; reload and retry."));
        if (code === "DIRECTORY_NOT_FOUND")
          return reply.code(404).send(errorResponse(code, "Directory item not found."));
        if (code === "DIRECTORY_ACCESS_DENIED")
          return reply.code(403).send(errorResponse(code, "Directory access denied."));
        if (code === "DIRECTORY_CONFLICT" || code === "DIRECTORY_IN_USE")
          return reply
            .code(409)
            .send(
              errorResponse(
                code,
                code === "DIRECTORY_IN_USE"
                  ? "Move active employees before disabling this directory item."
                  : "Directory item changed; reload and retry."
              )
            );
        throw error;
      }
    });
  }
}

import { getWebApiRoute, webApiErrorBody } from "@smedc/web-api-contract";
import {
  BROWSER_SESSION_COOKIE,
  type BrowserPrincipal,
  type BrowserSessions
} from "../auth/browser-session.js";
import { cookieValue, matchesCsrfToken } from "../auth/http-contract.js";
import { registerWebApiRoute } from "../web-api/register.js";

export function registerEmployeeDirectoryWebRoutes(
  app: FastifyInstance,
  options: { browserSessions: BrowserSessions; webOrigin: string; directory: () => Service }
) {
  const secret = (request: import("fastify").FastifyRequest) =>
    cookieValue(request.headers.cookie, BROWSER_SESSION_COOKIE);
  for (const action of Object.keys(directoryInputSchemas) as Array<
    keyof typeof directoryInputSchemas
  >) {
    const id = `directory.${action.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())}`;
    registerWebApiRoute<BrowserPrincipal>(app, getWebApiRoute(id), {
      authenticate: (request) => options.browserSessions.authenticate(secret(request)),
      verifyWrite: (request, principal) => {
        const cookie = secret(request),
          csrf = request.headers["x-csrf-token"];
        return (
          !!principal &&
          request.headers.origin === options.webOrigin &&
          cookie !== null &&
          typeof csrf === "string" &&
          matchesCsrfToken(cookie, csrf)
        );
      },
      handler: async ({ principal, params, body, reply }) => {
        if (!principal || principal.orgId !== params["orgId"]) {
          reply.code(403).send(webApiErrorBody("BROWSER_ACCESS_DENIED", "无权访问此企业。"));
          return null;
        }
        try {
          return await options.directory().execute(action, body, principal);
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            ["P2002", "P2034"].includes(String(error.code))
          ) {
            reply
              .code(409)
              .send(
                webApiErrorBody("DIRECTORY_CONFLICT", "目录项目已存在或已更改，请刷新后重试。")
              );
            return null;
          }
          if (code.startsWith("DIRECTORY_")) {
            reply
              .code(
                code === "DIRECTORY_NOT_FOUND"
                  ? 404
                  : code === "DIRECTORY_ACCESS_DENIED"
                    ? 403
                    : 409
              )
              .send(
                webApiErrorBody(
                  code,
                  code === "DIRECTORY_IN_USE"
                    ? "请先调整在职员工归属，再停用该目录项。"
                    : "请求无法完成，请刷新后重试。"
                )
              );
            return null;
          }
          throw error;
        }
      }
    });
  }
}
