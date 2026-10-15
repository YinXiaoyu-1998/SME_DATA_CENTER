import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CostCardPublicationError, ResourceAttributesError } from "@smedc/db";
import { StructuredQueryValidationError, parseCostCardSelection } from "@smedc/domain";
import type { CostCardService } from "../cost-cards.js";
import type { RequestAuth } from "../request-auth.js";
import { phase3ErrorResponse } from "../request-errors.js";

export function respondCostCardError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof StructuredQueryValidationError)
    return reply.code(400).send(phase3ErrorResponse(request, error.code, error.message));
  if (error instanceof ResourceAttributesError && error.code === "UPLOAD_ADMIN_REQUIRED")
    return reply
      .code(403)
      .send(
        phase3ErrorResponse(request, error.code, "A current active administrator is required.")
      );
  if (error instanceof CostCardPublicationError) {
    const status =
      error.code === "COST_CARD_NOT_FOUND"
        ? 404
        : error.code === "COST_CARD_ACCESS_DENIED"
          ? 403
          : 409;
    const message =
      error.code === "COST_CARD_CHANGED"
        ? "成本卡已变化，请重新下载"
        : error.code === "COST_CARD_MANIFEST_TOO_LARGE"
          ? "Cost card selection is too large; narrow the selection."
          : error.code === "COST_CARD_NOT_FOUND"
            ? "Cost card not found."
            : "Cost cards are unavailable for this request.";
    const response = phase3ErrorResponse(request, error.code, message);
    response.error.retryable = error.retryable;
    return reply.code(status).send(response);
  }
  throw error;
}
export function registerCostCardRoutes(
  app: FastifyInstance,
  dependencies: { auth: RequestAuth; costCards: () => CostCardService }
) {
  app.post("/v1/cost-cards/manifest", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!(await dependencies.auth.authenticate(request, reply))) return;
    try {
      return await dependencies.costCards().createCostCardManifest({
        auth: dependencies.auth.employee(request),
        selection: parseCostCardSelection(request.body)
      });
    } catch (error) {
      return respondCostCardError(error, request, reply);
    }
  });
  app.post<{ Params: { costCardId: string } }>(
    "/v1/cost-cards/:costCardId/archive",
    async (request, reply) => {
      if (!(await dependencies.auth.authenticate(request, reply))) return;
      try {
        if (
          !/^[A-Za-z0-9_-]{1,32}$/.test(request.params.costCardId) ||
          (request.body !== undefined &&
            (request.body === null ||
              typeof request.body !== "object" ||
              Array.isArray(request.body) ||
              Object.keys(request.body).length))
        )
          return reply
            .code(400)
            .send(
              phase3ErrorResponse(request, "INVALID_QUERY", "Cost card archive request is invalid.")
            );
        return await dependencies.costCards().archive({
          auth: dependencies.auth.employee(request),
          costCardId: request.params.costCardId
        });
      } catch (error) {
        return respondCostCardError(error, request, reply);
      }
    }
  );
}
