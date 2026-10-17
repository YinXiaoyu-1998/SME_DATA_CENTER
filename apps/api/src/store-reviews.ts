import {
  assertStoreReviewBatchBytes,
  parseStoreReviewBatch,
  parseStoreReviewQuery,
  StoreReviewValidationError,
  type StoreReviewActor
} from "@smedc/domain";
import type { StoreReviewRepository } from "@smedc/db";
import { PublicRequestError } from "./request-errors.js";

export function createStoreReviewService({ repository }: { repository: StoreReviewRepository }) {
  return {
    upsert({ auth, input }: { auth: StoreReviewActor; input: unknown }) {
      try {
        assertStoreReviewBatchBytes(input ?? null);
      } catch (error) {
        if (error instanceof StoreReviewValidationError)
          throw new PublicRequestError(413, "PAYLOAD_TOO_LARGE", "Request payload is too large.");
        throw error;
      }
      return repository.upsert({ id: auth.id, orgId: auth.orgId }, parseStoreReviewBatch(input));
    },
    query({ auth, input }: { auth: StoreReviewActor; input: unknown }) {
      return repository.query({ id: auth.id, orgId: auth.orgId }, parseStoreReviewQuery(input));
    }
  };
}
export type StoreReviewService = ReturnType<typeof createStoreReviewService>;
