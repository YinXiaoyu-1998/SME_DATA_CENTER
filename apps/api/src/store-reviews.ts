import {
  assertStoreReviewBatchBytes,
  parseStoreReviewBatch,
  parseStoreReviewQuery,
  StoreReviewBatchTooLargeError,
  type StoreReviewActor
} from "@smedc/domain";
import type { StoreReviewRepository } from "@smedc/db";
import { PublicRequestError } from "./request-errors.js";

export function createStoreReviewService({ repository }: { repository: StoreReviewRepository }) {
  return {
    async upsert({ auth, input }: { auth: StoreReviewActor; input: unknown }) {
      try {
        assertStoreReviewBatchBytes(input ?? null);
        return await repository.upsert(
          { id: auth.id, orgId: auth.orgId },
          parseStoreReviewBatch(input)
        );
      } catch (error) {
        if (error instanceof StoreReviewBatchTooLargeError)
          throw new PublicRequestError(413, "PAYLOAD_TOO_LARGE", "Request payload is too large.");
        throw error;
      }
    },
    query({ auth, input }: { auth: StoreReviewActor; input: unknown }) {
      return repository.query({ id: auth.id, orgId: auth.orgId }, parseStoreReviewQuery(input));
    }
  };
}
export type StoreReviewService = ReturnType<typeof createStoreReviewService>;
