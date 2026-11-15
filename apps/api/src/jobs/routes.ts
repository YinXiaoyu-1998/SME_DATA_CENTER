import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  jobRefSchema,
  jobMetadataPatchSchema,
  jobCorrectionSchema,
  queryJobsInputSchema
} from "@smedc/mcp-contract";
import type { EnterpriseWorkflowService } from "../enterprise-workflows/service.js";
import type { RequestAuth } from "../request-auth.js";
import type { RequestAuditContext } from "../request-audit-context.js";
import { errorResponse } from "../request-errors.js";

export function registerJobRoutes(
  app: FastifyInstance,
  dependencies: {
    auth: RequestAuth;
    workflows: () => EnterpriseWorkflowService;
    createBusinessRequestAudit: (request: FastifyRequest) => RequestAuditContext;
    cursorSigningSecret: string;
  }
) {
  const { auth, workflows, createBusinessRequestAudit, cursorSigningSecret } = dependencies;
  async function execute(
    request: FastifyRequest,
    reply: FastifyReply,
    run: (actor: ReturnType<RequestAuth["employee"]>) => Promise<unknown>
  ) {
    if (!(await auth.authenticate(request, reply))) return;
    try {
      return await run(auth.employee(request));
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const status = {
        JOB_VALIDATION_ERROR: 400,
        JOB_CURSOR_INVALID: 400,
        JOB_NOT_FOUND: 404,
        WORKFLOW_ADMIN_REQUIRED: 403,
        JOB_ACCESS_UNAVAILABLE: 403,
        JOB_VERSION_CONFLICT: 409,
        JOB_CORRECTION_UNAVAILABLE: 409,
        JOB_CORRECTION_EVIDENCE_REQUIRED: 409
      }[code];
      if (typeof status !== "number") throw error;
      return reply.code(status).send(errorResponse(code, "Job operation could not be completed."));
    }
  }
  const invalid = () => {
    throw new Error("JOB_VALIDATION_ERROR");
  };
  app.post("/v1/jobs/query", async (request, reply) =>
    execute(request, reply, (actor) => {
      const parsed = queryJobsInputSchema.safeParse(request.body);
      if (!parsed.success) return invalid();
      return workflows().queryJobs(actor, parsed.data.query, cursorSigningSecret);
    })
  );
  app.get("/v1/jobs/:kind/:id", async (request, reply) =>
    execute(request, reply, async (actor) => {
      const ref = jobRefSchema.safeParse(request.params);
      if (!ref.success) return invalid();
      const result = await workflows().queryJobs(
        actor,
        { mode: "detail", ...ref.data },
        cursorSigningSecret
      );
      if (!result.jobs[0]) throw new Error("JOB_NOT_FOUND");
      return result.jobs[0];
    })
  );
  app.patch("/v1/jobs/:kind/:id/metadata", async (request, reply) =>
    execute(request, reply, (actor) => {
      const ref = jobRefSchema.safeParse(request.params);
      const body = jobMetadataPatchSchema.safeParse(request.body);
      if (!ref.success || !body.success) return invalid();
      return workflows().patchJob(
        actor,
        createBusinessRequestAudit(request),
        ref.data.kind,
        ref.data.id,
        body.data
      );
    })
  );
  app.post("/v1/jobs/:kind/:id/corrections", async (request, reply) =>
    execute(request, reply, (actor) => {
      const ref = jobRefSchema.safeParse(request.params);
      const body = jobCorrectionSchema.safeParse(request.body);
      if (!ref.success || ref.data.kind !== "workflow_run" || !body.success) return invalid();
      return workflows().correctJob(
        actor,
        createBusinessRequestAudit(request),
        ref.data.id,
        body.data
      );
    })
  );
}
