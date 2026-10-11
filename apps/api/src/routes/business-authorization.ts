import type { FastifyInstance, FastifyReply } from "fastify";
import {
  isBusinessClearance,
  validateBusinessGrant,
  validateBusinessScope,
  type BusinessGrant,
  type BusinessScopeItem
} from "@smedc/domain";
import type { BusinessAuthorizationService } from "../business-authorization.js";
import type { RequestAuth } from "../request-auth.js";
import { errorResponse } from "../request-errors.js";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function grantShape(value: unknown): value is BusinessGrant {
  if (
    !object(value) ||
    !text(value["id"]) ||
    !text(value["orgId"]) ||
    !text(value["enterpriseKey"]) ||
    !Array.isArray(value["categoryIds"]) ||
    !value["categoryIds"].every(text) ||
    !object(value["dimensions"])
  )
    return false;
  const selection = (v: unknown) =>
    object(v) &&
    (v["kind"] === "all" ||
      (v["kind"] === "fixed" && Array.isArray(v["values"]) && v["values"].every(text)));
  return (
    Object.values(value["dimensions"]).every(selection) &&
    (value["ownership"] === "group"
      ? value["stores"] === undefined
      : value["ownership"] === "store" && selection(value["stores"]))
  );
}
function respondError(error: unknown, reply: FastifyReply) {
  const code = error instanceof Error ? error.message : "";
  if (object(error) && ["P2002", "P2003", "P2025"].includes(String(error["code"])))
    return reply
      .code(error["code"] === "P2025" ? 404 : 400)
      .send(
        errorResponse(
          "INVALID_PERMISSION_REFERENCE",
          "Permission configuration references an unavailable target."
        )
      );
  if (code === "AUTHORIZATION_VERSION_CONFLICT")
    return reply
      .code(409)
      .send(errorResponse(code, "Permission configuration changed. Reload and retry."));
  if (
    [
      "AUTHORIZATION_CUTOVER_NOT_READY",
      "AUTHORIZATION_SUSPENDED",
      "AUTHORIZATION_NOT_ENABLED"
    ].includes(code)
  )
    return reply
      .code(409)
      .send(
        errorResponse(
          code,
          "Authorization activation is unavailable. Review preparation or pause status."
        )
      );
  if (code === "AUTHORIZATION_ADMIN_REQUIRED")
    return reply.code(403).send(errorResponse(code, "A current active administrator is required."));
  if (code === "AUTHORIZATION_ACCOUNT_NOT_FOUND" || code === "RESOURCE_NOT_FOUND")
    return reply.code(404).send(errorResponse(code, "Permission target not found."));
  if (/^(INVALID_|CATEGORY_|RESOURCE_|SOURCE_|STORE_)/.test(code))
    return reply
      .code(400)
      .send(
        errorResponse("INVALID_PERMISSION_CONFIGURATION", "Permission configuration is invalid.")
      );
  throw error;
}
export function registerBusinessAuthorizationRoutes(
  app: FastifyInstance,
  dependencies: { auth: RequestAuth; permissions: () => BusinessAuthorizationService }
) {
  type Body = Record<string, unknown>;
  const invalid = (reply: FastifyReply) =>
    reply
      .code(400)
      .send(
        errorResponse("INVALID_PERMISSION_CONFIGURATION", "Permission configuration is invalid.")
      );
  function route(
    method: "GET" | "POST" | "PATCH",
    url: string,
    admin: boolean,
    handler: (
      service: BusinessAuthorizationService,
      actor: Awaited<ReturnType<BusinessAuthorizationService["current"]>>,
      params: Record<string, string>,
      body: Body,
      reply: FastifyReply
    ) => Promise<unknown>
  ) {
    app.route<{ Params: Record<string, string>; Body: Body }>({
      method,
      url,
      async handler(request, reply) {
        if (!(await dependencies.auth.authenticate(request, reply))) return;
        try {
          const service = dependencies.permissions();
          const actor = await service.current(dependencies.auth.employee(request), admin);
          const result = await handler(service, actor, request.params, request.body ?? {}, reply);
          return reply.sent
            ? result
            : JSON.parse(
                JSON.stringify(result, (_key, value: unknown) =>
                  typeof value === "bigint" ? value.toString() : value
                )
              );
        } catch (error) {
          return respondError(error, reply);
        }
      }
    });
  }
  route("GET", "/v1/admin/permissions/cutover", true, async (service, actor) =>
    service.prepareAuthorizationCutover(actor.orgId)
  );
  for (const operation of ["activate", "suspend"] as const)
    route(
      "POST",
      `/v1/admin/permissions/cutover/${operation}`,
      true,
      async (service, actor, _params, body, reply) => {
        if (
          !text(body["expectedVersion"]) ||
          body["confirm"] !== true ||
          Object.keys(body).some((key) => !["expectedVersion", "confirm"].includes(key))
        )
          return invalid(reply);
        return operation === "activate"
          ? service.activateAuthorizationCutover(actor, body["expectedVersion"], true)
          : service.repository.suspendAuthorizationReads({
              orgId: actor.orgId,
              actorId: actor.employeeId,
              expectedVersion: body["expectedVersion"],
              confirm: true
            });
      }
    );
  route("GET", "/v1/permissions/me", false, async (_service, actor) => ({
    ...actor,
    categories: actor.categories.filter((category) =>
      actor.grants.some((grant) => grant.categoryIds.includes(category.id))
    )
  }));
  route("GET", "/v1/admin/permissions/accounts", true, async (service, actor) => ({
    accounts: await service.repository.listAccounts(actor.orgId, actor.employeeId)
  }));
  route("GET", "/v1/admin/permissions/accounts/:employeeId", true, async (service, actor, params) =>
    service.repository.loadAuthorizationSnapshot(params["employeeId"]!, actor.orgId)
  );
  route(
    "PATCH",
    "/v1/admin/permissions/accounts/:employeeId",
    true,
    async (service, actor, params, body, reply) => {
      if (
        !text(body["expectedVersion"]) ||
        !isBusinessClearance(body["clearance"]) ||
        !Array.isArray(body["grants"]) ||
        !body["grants"].every(grantShape)
      )
        return invalid(reply);
      const grants = body["grants"];
      if (
        grants.some(
          (grant) =>
            grant.orgId !== actor.orgId || validateBusinessGrant(grant, actor.categories).length
        )
      )
        return invalid(reply);
      return service.repository.configureAccount({
        orgId: actor.orgId,
        actorId: actor.employeeId,
        employeeId: params["employeeId"]!,
        expectedVersion: body["expectedVersion"],
        clearance: body["clearance"],
        grants
      });
    }
  );

  route("GET", "/v1/admin/permissions/stores", true, async (service, actor) => ({
    authorizationVersion: actor.authorizationVersion,
    stores: await service.repository.listStores(actor.orgId)
  }));
  route(
    "POST",
    "/v1/admin/permissions/stores",
    true,
    async (service, actor, _params, body, reply) => {
      if (
        !text(body["expectedVersion"]) ||
        !text(body["enterpriseKey"]) ||
        !text(body["name"]) ||
        (body["retired"] !== undefined && typeof body["retired"] !== "boolean") ||
        Object.keys(body).some(
          (key) => !["expectedVersion", "enterpriseKey", "name", "retired"].includes(key)
        )
      )
        return invalid(reply);
      return service.repository.putStore({
        orgId: actor.orgId,
        actorId: actor.employeeId,
        expectedVersion: body["expectedVersion"],
        enterpriseKey: body["enterpriseKey"],
        name: body["name"],
        ...(typeof body["retired"] === "boolean" ? { retired: body["retired"] } : {})
      });
    }
  );
  for (const directory of ["categories", "dimensions"] as const) {
    const base = `/v1/admin/permissions/${directory}`;
    route("GET", base, true, async (service, actor) => ({
      authorizationVersion: actor.authorizationVersion,
      [directory]:
        directory === "categories"
          ? await service.repository.listCategories(actor.orgId)
          : await service.repository.listDimensions(actor.orgId)
    }));
    for (const method of ["POST", "PATCH"] as const)
      route(
        method,
        method === "POST" ? base : `${base}/:id`,
        true,
        async (service, actor, params, body, reply) => {
          const id = method === "POST" ? body["id"] : params["id"];
          if (
            !text(id) ||
            !text(body["expectedVersion"]) ||
            !text(body["name"]) ||
            (body["retired"] !== undefined && typeof body["retired"] !== "boolean")
          )
            return invalid(reply);
          const context = {
            orgId: actor.orgId,
            actorId: actor.employeeId,
            expectedVersion: body["expectedVersion"],
            id,
            name: body["name"],
            ...(typeof body["retired"] === "boolean" ? { retired: body["retired"] } : {})
          };
          if (directory === "dimensions")
            return service.repository.defineDimension({
              ...context,
              createOnly: method === "POST",
              updateOnly: method === "PATCH"
            });
          const existing = (await service.repository.listCategories(actor.orgId)).find(
            (category) => category.id === id
          );
          if (method === "PATCH" && !existing)
            return reply.code(404).send(errorResponse("CATEGORY_NOT_FOUND", "Category not found."));
          if (existing?.kind === "fixed") {
            if (method === "POST") return invalid(reply);
            if (
              body["ownerships"] !== undefined ||
              body["requiredDimensionIds"] !== undefined ||
              body["kind"] !== undefined ||
              body["key"] !== undefined ||
              !isBusinessClearance(body["confidentialityLevel"])
            )
              return invalid(reply);
            return service.repository.configureCategory({
              ...context,
              kind: "fixed",
              key: existing.key!,
              confidentialityLevel: body["confidentialityLevel"],
              ownerships: [existing.allowStore ? "store" : "group"],
              requiredDimensionIds: existing.dimensions.map((d) => d.dimensionId)
            });
          }
          if (
            !Array.isArray(body["ownerships"]) ||
            !body["ownerships"].length ||
            !body["ownerships"].every((v) => v === "store" || v === "group") ||
            !Array.isArray(body["requiredDimensionIds"]) ||
            !body["requiredDimensionIds"].every(text) ||
            (body["kind"] !== undefined && body["kind"] !== "evidence") ||
            body["key"] !== undefined
          )
            return invalid(reply);
          return service.repository.configureCategory({
            ...context,
            createOnly: method === "POST",
            kind: "evidence",
            confidentialityLevel: null,
            ownerships: body["ownerships"] as ("group" | "store")[],
            requiredDimensionIds: body["requiredDimensionIds"]
          });
        }
      );
  }
  for (const method of ["POST", "PATCH"] as const)
    route(
      method,
      `/v1/admin/permissions/dimensions/:dimensionId/values${method === "PATCH" ? "/:id" : ""}`,
      true,
      async (service, actor, params, body, reply) => {
        const id = method === "POST" ? body["id"] : params["id"];
        if (
          !text(id) ||
          !text(body["name"]) ||
          !text(body["expectedVersion"]) ||
          (body["retired"] !== undefined && typeof body["retired"] !== "boolean")
        )
          return invalid(reply);
        return service.repository.defineDimensionValue({
          orgId: actor.orgId,
          actorId: actor.employeeId,
          expectedVersion: body["expectedVersion"],
          id,
          dimensionId: params["dimensionId"]!,
          name: body["name"],
          createOnly: method === "POST",
          updateOnly: method === "PATCH",
          ...(typeof body["retired"] === "boolean" ? { retired: body["retired"] } : {})
        });
      }
    );
  route(
    "PATCH",
    "/v1/admin/permissions/documents/:documentId",
    true,
    async (service, actor, params, body, reply) => {
      if (
        !text(body["expectedVersion"]) ||
        !text(body["categoryId"]) ||
        !isBusinessClearance(body["fileConfidentialityLevel"]) ||
        !Array.isArray(body["scopes"]) ||
        (body["historicalSupplementReason"] !== undefined &&
          (!text(body["historicalSupplementReason"]) ||
            body["historicalSupplementReason"].length > 2048))
      )
        return invalid(reply);
      const category = actor.categories.find(
        (rule) => rule.id === body["categoryId"] && rule.kind === "evidence"
      );
      if (
        !category ||
        !body["scopes"].every(
          (scope) =>
            object(scope) &&
            object(scope["dimensions"]) &&
            validateBusinessScope(scope as unknown as BusinessScopeItem, category)
        )
      )
        return invalid(reply);
      return service.repository.configureEvidenceDocument({
        orgId: actor.orgId,
        actorId: actor.employeeId,
        expectedVersion: body["expectedVersion"],
        documentId: params["documentId"]!,
        categoryId: body["categoryId"],
        fileConfidentialityLevel: body["fileConfidentialityLevel"],
        scopes: body["scopes"] as BusinessScopeItem[],
        ...(typeof body["historicalSupplementReason"] === "string"
          ? { historicalSupplementReason: body["historicalSupplementReason"] }
          : {})
      });
    }
  );
}
