import type { FastifyInstance } from "fastify";
import type { RequestAuth } from "../request-auth.js";
import {
  DISH_CATALOG_BATCH_BYTES,
  DishCatalogRequestError,
  type DishCatalogService
} from "../dish-catalog.js";
import { phase3ErrorResponse } from "../request-errors.js";

export function registerDishCatalogRoutes(
  app: FastifyInstance,
  dependencies: { auth: RequestAuth; dishCatalog: () => DishCatalogService }
) {
  void app.register(async (catalogApp) => {
    // JSON.parse preserves arbitrary own keys without invoking prototype setters.
    // Limit this parser to the dish catalog route; domain validation rejects other shapes.
    catalogApp.removeContentTypeParser("application/json");
    catalogApp.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      catalogApp.getDefaultJsonParser("ignore", "ignore")
    );
    catalogApp.post(
      "/v1/dish-catalog/upsert",
      { bodyLimit: DISH_CATALOG_BATCH_BYTES },
      async (request, reply) => {
        reply.header("cache-control", "no-store");
        if (!(await dependencies.auth.authenticate(request, reply))) return;
        try {
          return await dependencies.dishCatalog().upsert({
            auth: dependencies.auth.employee(request),
            input: request.body,
            requestId: request.id
          });
        } catch (error) {
          if (error instanceof DishCatalogRequestError)
            return reply
              .code(error.statusCode)
              .send(phase3ErrorResponse(request, error.code, error.message, error.details));
          throw error;
        }
      }
    );
  });
}
