import type { FastifyInstance } from "fastify";
import { ComboSaleMappingError, type createComboSaleMappingRepository } from "@smedc/db";
import { queryComboSaleMappingsInput, updateComboSaleMappingInput } from "@smedc/domain";
import { phase3ErrorResponse } from "../request-errors.js";
import type { RequestAuth } from "../request-auth.js";

export function registerComboSaleMappingRoutes(
  app: FastifyInstance,
  auth: RequestAuth,
  repository: () => ReturnType<typeof createComboSaleMappingRepository>
) {
  for (const action of ["query", "update"] as const) {
    app.post("/v1/combo-sale-mappings/" + action, async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!(await auth.authenticate(request, reply))) return;
      const actor = { ...auth.employee(request), requestId: request.id };
      try {
        if (action === "query") {
          const input = queryComboSaleMappingsInput.safeParse(request.body);
          if (input.success) return await repository().query(actor, input.data);
        } else {
          const input = updateComboSaleMappingInput.safeParse(request.body);
          if (input.success) return await repository().update(actor, input.data);
        }
        return reply
          .code(400)
          .send(
            phase3ErrorResponse(
              request,
              "COMBO_SALE_MAPPING_INVALID_INPUT",
              "Invalid combo sale mapping input."
            )
          );
      } catch (error) {
        if (error instanceof ComboSaleMappingError)
          return reply
            .code(error.status)
            .send(phase3ErrorResponse(request, error.code, error.message));
        throw error;
      }
    });
  }
}
