import { randomUUID } from "node:crypto";
import { createPdfUploadAdmission } from "./pdf-upload-admission.js";
import Fastify from "fastify";
import { DEFAULT_RETRIEVAL_CONFIG_VERSION } from "@smedc/domain";
import { registerMcpHttpRoute } from "./mcp/http.js";
import { registerOfficialAuthRoutes } from "./auth/routes.js";
import { registerApiErrorHandler } from "./request-errors.js";
import { isTrustedLoopbackProxy, normalizeRequestId } from "./request-audit-context.js";
import { createApiServerContext, type ApiServerOptions } from "./app-context.js";
import { createRequestAuth, type AuthenticatedRequest } from "./request-auth.js";
import { registerApiMultipart } from "./http/multipart.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerCatalogRoutes } from "./routes/catalog.js";
import { registerStructuredQueryRoutes } from "./routes/structured-query.js";
import { registerEvidenceRoutes } from "./routes/evidence.js";
import { registerStructuredImportRoutes } from "./routes/structured-import/routes.js";
import { registerQuarantineCertificateRoutes } from "./routes/quarantine-certificates.js";
import { registerSourceDocumentRoutes } from "./routes/source-documents.js";
import { registerStructuredPartitionRoutes } from "./routes/structured-partitions/routes.js";

export type { ApiServerOptions } from "./app-context.js";

export function buildApiServer(options: ApiServerOptions = {}) {
  const context = createApiServerContext(options);
  const requestAuth = createRequestAuth(context);
  const { environment, delegationProof, runtimeLimits, cursorSigningSecret, readinessCheck } =
    context;
  const documents = context.documents;
  const storage = context.storage;
  const structuredImports = context.structuredImports;
  const structuredQueries = context.structuredQueries;
  const structuredCoverage = context.structuredCoverage;
  const structuredPartitions = context.structuredPartitions;
  const quarantineCertificates = context.quarantineCertificates;
  const sourceDocumentDownloads = context.sourceDocumentDownloads;
  const skills = context.skills;
  const evidence = context.evidence;
  const createBusinessRequestAudit = context.createBusinessRequestAudit;
  const uploadAuthorizationDependencies = {
    uploadAuthorizationAudit: context.uploadAuthorizationAudit,
    createBusinessRequestAudit
  };

  const app = Fastify({
    logger: options.logger ?? true,
    requestIdHeader: false,
    genReqId(rawRequest) {
      return normalizeRequestId(rawRequest.headers["x-request-id"]) ?? `req_${randomUUID()}`;
    },
    trustProxy(address) {
      return isTrustedLoopbackProxy(address);
    }
  });

  registerApiErrorHandler(app);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.addHook("onClose", async () => {
    await context.close();
  });

  registerApiMultipart(app, { maxUploadBytes: runtimeLimits.maxUploadBytes });

  registerMcpHttpRoute(app, {
    ...uploadAuthorizationDependencies,
    maxUploadBytes: runtimeLimits.maxUploadBytes,
    delegationProof,
    mcpMaxConcurrentRequests: runtimeLimits.mcpMaxConcurrentRequests,
    publicOrigin: (options.runtimeEnv ?? process.env)["SMEDC_PUBLIC_ORIGIN"],
    authenticate: async (request, reply) => {
      const authenticated = await requestAuth.authenticate(request, reply);

      if (!authenticated) {
        return null;
      }

      return (request as AuthenticatedRequest).employee;
    }
  });

  if (context.authCore) {
    const publicOrigin = environment["SMEDC_PUBLIC_ORIGIN"];
    if (!publicOrigin) {
      throw new Error("SMEDC_PUBLIC_ORIGIN is required for official authentication.");
    }
    registerOfficialAuthRoutes(app, { auth: context.authCore, publicOrigin });
    void context.authCore.pruneSecurityEvents().catch((error: unknown) => {
      app.log.error({ err: error }, "Failed to prune expired authentication security events.");
    });
    const pruneTimer = setInterval(
      () => {
        void context.authCore?.pruneSecurityEvents().catch((error: unknown) => {
          app.log.error({ err: error }, "Failed to prune expired authentication security events.");
        });
      },
      24 * 60 * 60 * 1000
    );
    pruneTimer.unref();
    app.addHook("onClose", async () => clearInterval(pruneTimer));
  }

  registerSystemRoutes(app, { auth: requestAuth, readinessCheck });

  registerEvidenceRoutes(app, {
    ...uploadAuthorizationDependencies,
    auth: requestAuth,
    documents,
    storage,
    evidence,
    pdfUploadAdmission: createPdfUploadAdmission({
      environment,
      verifyRollbackFloor: options.pdfRollbackFloorVerifier
    }),
    sourceDocumentDownloads,
    cursorSigningSecret,
    retrievalConfigVersion:
      environment["RETRIEVAL_CONFIG_VERSION"]?.trim() || DEFAULT_RETRIEVAL_CONFIG_VERSION
  });

  registerStructuredImportRoutes(app, {
    ...uploadAuthorizationDependencies,
    auth: requestAuth,
    storage,
    structuredImports,
    runtimeLimits
  });

  registerStructuredPartitionRoutes(app, {
    ...uploadAuthorizationDependencies,
    auth: requestAuth,
    storage,
    partitions: context.structuredPartitions,
    runtimeLimits
  });

  registerQuarantineCertificateRoutes(app, {
    ...uploadAuthorizationDependencies,
    auth: requestAuth,
    storage,
    quarantineCertificates
  });

  registerSourceDocumentRoutes(app, {
    auth: requestAuth,
    sourceDocumentDownloads,
    createBusinessRequestAudit
  });

  registerStructuredQueryRoutes(app, {
    auth: requestAuth,
    structuredQueries,
    structuredCoverage,
    structuredPartitions,
    cursorSigningSecret
  });

  registerCatalogRoutes(app, { auth: requestAuth, skills });

  return app;
}
