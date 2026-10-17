import type { FastifyInstance } from "fastify";
import { ResourceAttributesError, StoreReviewRepositoryError } from "@smedc/db";
import {
  STORE_REVIEW_LIMITS,
  StoreReviewValidationError,
  StructuredQueryValidationError
} from "@smedc/domain";
import type { StoreReviewService } from "../store-reviews.js";
import type { RequestAuth } from "../request-auth.js";
import { phase3ErrorResponse } from "../request-errors.js";

export function registerStoreReviewRoutes(
  app: FastifyInstance,
  dependencies: { auth: RequestAuth; storeReviews: () => StoreReviewService }
) {
  void app.register(async (reviewsApp) => {
    // JSON.parse preserves arbitrary own score keys without invoking prototype setters.
    // Limit this parser to the review endpoints; domain validation rejects other shapes.
    reviewsApp.removeContentTypeParser("application/json");
    reviewsApp.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      reviewsApp.getDefaultJsonParser("ignore", "ignore")
    );
    for (const action of ["upsert", "query"] as const) {
      reviewsApp.post(
        `/v1/store-reviews/${action}`,
        action === "upsert" ? { bodyLimit: STORE_REVIEW_LIMITS.batchBytes } : {},
        async (request, reply) => {
          reply.header("cache-control", "no-store");
          if (!(await dependencies.auth.authenticate(request, reply))) return;
          try {
            return await dependencies.storeReviews()[action]({
              auth: dependencies.auth.employee(request),
              input: request.body
            });
          } catch (error) {
            if (error instanceof StoreReviewValidationError)
              return reply.code(400).send(
                phase3ErrorResponse(request, error.code, "Invalid store review input.", {
                  ...(error.details.index !== undefined ? { index: error.details.index } : {}),
                  ...(error.details.duplicateIndex !== undefined
                    ? { duplicateIndex: error.details.duplicateIndex }
                    : {})
                })
              );
            if (error instanceof StructuredQueryValidationError)
              return reply
                .code(400)
                .send(
                  phase3ErrorResponse(
                    request,
                    error.code,
                    "Invalid or expired review cursor; restart the query."
                  )
                );
            if (error instanceof Error && error.message === "AUTHORIZATION_ACCOUNT_NOT_FOUND")
              return reply
                .code(403)
                .send(
                  phase3ErrorResponse(
                    request,
                    "STORE_REVIEW_ACCESS_DENIED",
                    "Store reviews are unavailable for this request."
                  )
                );
            if (
              error instanceof StoreReviewRepositoryError ||
              error instanceof ResourceAttributesError
            ) {
              const forbidden = [
                "STORE_REVIEW_ACCESS_DENIED",
                "UPLOAD_ADMIN_REQUIRED",
                "EMPLOYEE_DISABLED"
              ];
              const status = forbidden.includes(error.code)
                ? 403
                : error.code === "STORE_REVIEW_WRITE_FAILED"
                  ? 500
                  : 409;
              return reply
                .code(status)
                .send(
                  phase3ErrorResponse(
                    request,
                    error.code,
                    "Store reviews are unavailable for this request.",
                    error instanceof StoreReviewRepositoryError ? error.details : {}
                  )
                );
            }
            throw error;
          }
        }
      );
    }
  });
}
