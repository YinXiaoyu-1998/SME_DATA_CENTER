import Fastify from "fastify";
import { PrismaClient } from "@prisma/client";
import { createBusinessAuthorizationRepository, createDatabaseAdapter } from "@smedc/db";
import { createBusinessAuthorizationService } from "../business-authorization.js";
import {
  registerBusinessAuthorizationRoutes,
  respondBusinessAuthorizationError
} from "../routes/business-authorization.js";
import { createPrismaPermissionsUiMetadata } from "../admin-permissions/metadata.js";
import { errorResponse } from "../request-errors.js";
import type { DataCommand, PermissionSection, PermissionsOperatorRuntime } from "./cli.js";

export async function openPermissionsOperatorRuntime(
  command: DataCommand,
  databaseUrl = process.env["DATABASE_URL"]
): Promise<PermissionsOperatorRuntime> {
  if (!databaseUrl) throw new Error("OPERATOR_DATABASE_URL_REQUIRED");
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
  const app = Fastify({ logger: false });
  const close = async () => {
    try {
      await app.close();
    } finally {
      await prisma.$disconnect();
    }
  };
  try {
    const requestedBy = await prisma.employee.findUnique({
      where: { orgId_id: { orgId: command.orgId, id: command.requestedByAdminId } },
      select: {
        id: true,
        orgId: true,
        displayName: true,
        email: true,
        role: true,
        clearance: true,
        disabled: true,
        organization: { select: { name: true } }
      }
    });
    if (!requestedBy || requestedBy.disabled || requestedBy.role !== "admin")
      throw new Error("AUTHORIZATION_ADMIN_REQUIRED");
    const repository = createBusinessAuthorizationRepository({
      prisma,
      ...(command.kind === "apply"
        ? {
            operatorAudit: {
              operatorId: command.operatorId,
              requestReference: command.requestReference,
              reason: command.reason
            }
          }
        : {})
    });
    const service = createBusinessAuthorizationService(repository);
    const metadata = createPrismaPermissionsUiMetadata(prisma);
    const employee = { ...requestedBy, organizationName: requestedBy.organization.name };
    // This router never listens on a socket. The operator is authenticated by restricted
    // access to the server/runtime DB; the named requesting admin is checked live by
    // the shared handlers and again under the repository's write transaction lock.
    registerBusinessAuthorizationRoutes(app, {
      auth: { authenticate: async () => true, employee: () => employee },
      permissions: () => service,
      adminBase: "/internal/permissions",
      selfPath: "/internal/permissions/me"
    });
    app.patch<{ Params: { employeeId: string }; Body: Record<string, unknown> }>(
      "/internal/permissions/accounts/:employeeId/role",
      async (request, reply) => {
        try {
          const actor = await service.current(employee, true);
          const body = request.body;
          if (
            !body ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            Object.keys(body).some((key) => key !== "role" && key !== "expectedVersion") ||
            (body["role"] !== "admin" && body["role"] !== "employee") ||
            typeof body["expectedVersion"] !== "string"
          )
            throw new Error("INVALID_ACCOUNT_ROLE");
          return await repository.configureAccountRole({
            orgId: actor.orgId,
            actorId: actor.employeeId,
            employeeId: request.params.employeeId,
            role: body["role"],
            expectedVersion: body["expectedVersion"]
          });
        } catch (error) {
          if (error instanceof Error && error.message === "AUTHORIZATION_LAST_ADMIN_REQUIRED")
            return reply
              .code(409)
              .send(
                errorResponse(
                  error.message,
                  "Keep at least one active administrator in this organization."
                )
              );
          return respondBusinessAuthorizationError(error, reply);
        }
      }
    );
    app.post<{ Body: { name: string; expectedVersion: string } }>(
      "/internal/permissions/enterprises",
      async (request, reply) => {
        try {
          const actor = await service.current(employee, true);
          return await repository.declareEnterpriseIdentity({
            orgId: actor.orgId,
            actorId: actor.employeeId,
            name: request.body.name,
            expectedVersion: request.body.expectedVersion
          });
        } catch (error) {
          return respondBusinessAuthorizationError(error, reply);
        }
      }
    );
    await app.ready();
    return {
      async inspect(section: PermissionSection, query = {}) {
        const actor = await service.current(employee, true);
        const readers = {
          accounts: () => repository.listAccounts(actor.orgId, actor.employeeId),
          categories: () => repository.listCategories(actor.orgId),
          stores: () => repository.listStores(actor.orgId),
          dimensions: () => repository.listDimensions(actor.orgId),
          enterprises: () => metadata.listEnterprises(actor.orgId),
          documents: () => metadata.listDocuments(actor.orgId, query),
          readiness: () => service.prepareAuthorizationCutover(actor.orgId)
        };
        const selected =
          section === "all"
            ? ([
                "accounts",
                "categories",
                "stores",
                "dimensions",
                "enterprises",
                "documents"
              ] as const)
            : [section];
        const values = await Promise.all(
          selected.map(async (key) => [key, await readers[key]()] as const)
        );
        return {
          orgId: actor.orgId,
          requestedByAdminId: actor.employeeId,
          authorizationVersion: actor.authorizationVersion,
          mode: actor.mode,
          ...Object.fromEntries(values)
        };
      },
      async apply(change) {
        const response = await app.inject({
          method: change.method,
          url: change.url,
          payload: change.body
        });
        const body = response.json<{ error?: { code?: string } }>();
        if (response.statusCode >= 400)
          throw new Error(body.error?.code ?? "OPERATOR_CHANGE_REJECTED");
        return body;
      },
      close
    };
  } catch (error) {
    await close();
    throw error;
  }
}
