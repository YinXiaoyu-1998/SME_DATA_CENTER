import { compileStructuredReadScope } from "./business-authorization-sql.js";
import {
  ResourceAttributesError,
  createBusinessAuthorizationRepository
} from "./business-authorization.js";
import { loadStoreReviewEnterpriseOptions } from "./store-review-enterprises.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Prisma, type PrismaClient, type StoreReview } from "@prisma/client";
import {
  isBusinessClearance,
  STORE_REVIEW_LIMITS,
  storeReviewQueryResponseBytes,
  assertStoreReviewBatchBytes,
  parseStoreReviewBatch,
  resolveStoreReviewReplyState,
  StoreReviewValidationError,
  normalizeEnterpriseIdentity,
  type StoreReviewActor,
  type StoreReviewInput,
  type UpsertStoreReviewsInput,
  createStructuredCursor,
  decodeStructuredCursor,
  hashStoreReviewQueryScope,
  parseStoreReviewQuery,
  type StoreReviewQuery,
  type StoreReviewQueryResult,
  type StoreReviewSource,
  type StoreReviewReplyStatus,
  type StoreReviewScores,
  type StoreReviewWriteResult
} from "@smedc/domain";
import {
  lockAuthorizationPublication,
  persistStoreReviewResource,
  requireCurrentUploadAdmin
} from "./source-read-requirements.js";
import { categoriesInclude } from "./business-authorization-records.js";
export class StoreReviewRepositoryError extends Error {
  constructor(
    readonly code: string,
    readonly details: { index?: number } = {}
  ) {
    super(code);
    this.name = "StoreReviewRepositoryError";
  }
}
export interface StoreReviewRepository {
  query(actor: StoreReviewActor, input: StoreReviewQuery): Promise<StoreReviewQueryResult>;
  upsert(actor: StoreReviewActor, input: UpsertStoreReviewsInput): Promise<StoreReviewWriteResult>;
}
function key(row: {
  enterpriseKey: string;
  source: string;
  storeName: string;
  reviewedAt: Date;
  reviewerName: string;
}) {
  return JSON.stringify([
    row.enterpriseKey,
    row.source,
    row.storeName,
    row.reviewedAt.toISOString(),
    row.reviewerName
  ]);
}
function patch(row: StoreReviewInput): Prisma.StoreReviewUpdateInput {
  return {
    ...(Object.hasOwn(row, "content") ? { content: row.content } : {}),
    ...(Object.hasOwn(row, "merchantReply") ? { merchantReply: row.merchantReply } : {}),
    ...(Object.hasOwn(row, "replyStatus") ? { replyStatus: row.replyStatus } : {}),
    ...(Object.hasOwn(row, "scores") ? { scores: Prisma.DbNull } : {})
  };
}
function changed(existing: StoreReview, input: StoreReviewInput) {
  return (["content", "scores", "merchantReply", "replyStatus"] as const).some(
    (field) => Object.hasOwn(input, field) && !isDeepStrictEqual(existing[field], input[field])
  );
}
export function createPrismaStoreReviewRepository({
  prisma,
  cursorSecret
}: {
  prisma: PrismaClient;
  cursorSecret: string;
}): StoreReviewRepository {
  const permissions = createBusinessAuthorizationRepository({ prisma });
  return {
    async query(actor, input) {
      const query = parseStoreReviewQuery(input);
      return prisma.$transaction(
        async (tx) => {
          const snapshot = await permissions.loadAuthorizationSnapshot(actor.id, actor.orgId, tx);
          const enterpriseKey = normalizeEnterpriseIdentity(query.enterpriseName).enterpriseKey;
          const options = await loadStoreReviewEnterpriseOptions(tx, snapshot);
          if (
            !options.read.some(
              (e) => e.enterpriseKey === enterpriseKey && e.enterpriseName === query.enterpriseName
            )
          )
            throw new StoreReviewRepositoryError("STORE_REVIEW_ACCESS_DENIED");
          const authorization = compileStructuredReadScope(
            snapshot,
            "store_review",
            "store_reviews"
          );
          const shapeHash = hashStoreReviewQueryScope({
            orgId: actor.orgId,
            employeeId: actor.id,
            enterpriseKey,
            authorizationVersion: snapshot.authorizationVersion,
            query
          });
          const offset = query.cursor
            ? decodeStructuredCursor({
                cursor: query.cursor,
                expectedShapeHash: shapeHash,
                secret: cursorSecret
              }).offset
            : 0;
          const conditions = [
            "CAST(v.org_id AS BINARY) = CAST(? AS BINARY)",
            "CAST(v.enterprise_key AS BINARY) = CAST(? AS BINARY)",
            `(${authorization.sql})`
          ];
          const params: Array<string | number | Date> = [
            actor.orgId,
            enterpriseKey,
            ...authorization.params
          ];
          for (const [values, column] of [
            [query.storeNames, "store_name"],
            [query.sources, "source"],
            [query.replyStatuses, "reply_status"]
          ] as const)
            if (values) {
              conditions.push(
                `CAST(v.${column} AS BINARY) IN (${values.map(() => "CAST(? AS BINARY)").join(", ")})`
              );
              params.push(...values);
            }
          for (const [value, operator] of [
            [query.reviewedAtFrom, ">="],
            [query.reviewedAtTo, "<="]
          ] as const)
            if (value) {
              conditions.push(`v.reviewed_at ${operator} ?`);
              params.push(new Date(value));
            }
          if (query.reviewerName !== undefined) {
            conditions.push("CAST(v.reviewer_name AS BINARY) = CAST(? AS BINARY)");
            params.push(query.reviewerName);
          }
          if (query.hasReply !== undefined)
            conditions.push(
              query.hasReply
                ? "(v.merchant_reply IS NOT NULL AND OCTET_LENGTH(v.merchant_reply) > 0)"
                : "(v.merchant_reply IS NULL OR OCTET_LENGTH(v.merchant_reply) = 0)"
            );
          const limit = query.limit!;
          const rows = await tx.$queryRawUnsafe<
            Array<{
              id: string;
              source: StoreReviewSource;
              storeName: string;
              reviewedAt: Date;
              reviewerName: string;
              content: string | null;
              scores: StoreReviewScores | string;
              merchantReply: string | null;
              replyStatus: StoreReviewReplyStatus;
              createdAt: Date;
              updatedAt: Date;
            }>
          >(
            `SELECT v.id, v.source, v.store_name AS storeName, v.reviewed_at AS reviewedAt, v.reviewer_name AS reviewerName, v.content, CAST(v.scores AS CHAR CHARACTER SET utf8mb4) AS scores, v.merchant_reply AS merchantReply, v.reply_status AS replyStatus, v.created_at AS createdAt, v.updated_at AS updatedAt FROM store_reviews v WHERE ${conditions.join(" AND ")} ORDER BY v.reviewed_at DESC, v.id DESC LIMIT ? OFFSET ?`,
            ...params,
            limit + 1,
            offset
          );
          const beijing = (date: Date) =>
            new Date(date.getTime() + 28800000).toISOString().slice(0, 19) + "+08:00";
          const publicRows = rows.slice(0, limit).map((row) => ({
            ...row,
            enterpriseName: query.enterpriseName,
            scores:
              typeof row.scores === "string"
                ? (JSON.parse(row.scores) as StoreReviewScores)
                : row.scores,
            reviewedAt: beijing(row.reviewedAt),
            createdAt: beijing(row.createdAt),
            updatedAt: beijing(row.updatedAt)
          }));
          const page = (count: number): StoreReviewQueryResult => ({
            rows: publicRows.slice(0, count),
            page: {
              nextCursor:
                rows.length > count
                  ? createStructuredCursor({
                      offset: offset + count,
                      shapeHash,
                      secret: cursorSecret
                    })
                  : null
            }
          });
          let count = publicRows.length;
          if (storeReviewQueryResponseBytes(page(count)) > STORE_REVIEW_LIMITS.queryResponseBytes) {
            // Return the largest complete-row prefix that fits a default MCP client's
            // input buffer, accounting for JSON text's second layer of escaping.
            let low = 1,
              high = count;
            while (low < high) {
              const middle = Math.ceil((low + high) / 2);
              if (
                storeReviewQueryResponseBytes(page(middle)) <=
                STORE_REVIEW_LIMITS.queryResponseBytes
              )
                low = middle;
              else high = middle - 1;
            }
            count = low;
          }
          const result = page(count);
          if (storeReviewQueryResponseBytes(result) > STORE_REVIEW_LIMITS.queryResponseBytes)
            throw new StoreReviewRepositoryError("STORE_REVIEW_RESPONSE_TOO_LARGE");
          return result;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
      );
    },
    async upsert(actor, input) {
      // Validate again at the persistence boundary so direct clients share the HTTP/MCP budget.
      assertStoreReviewBatchBytes(input);
      const parsed = parseStoreReviewBatch(input);
      return prisma.$transaction(
        async (tx) => {
          const state = await lockAuthorizationPublication(tx, actor.orgId);
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM employees WHERE org_id = ${actor.orgId} AND id = ${actor.id} FOR SHARE`
          );
          await requireCurrentUploadAdmin(tx, actor.orgId, actor.id);
          if (state.mode !== "enabled")
            throw new StoreReviewRepositoryError("AUTHORIZATION_NOT_ENABLED");
          const category = await tx.businessCategory.findUnique({
            where: { orgId_key: { orgId: actor.orgId, key: "store_reviews" } },
            include: categoriesInclude
          });
          if (
            !category ||
            !isBusinessClearance(category.confidentialityLevel) ||
            category.retired ||
            category.dimensions.length
          )
            throw new StoreReviewRepositoryError("RESOURCE_CATEGORY_NOT_CONFIGURED");
          const enterprises = await tx.businessEnterpriseIdentity.findMany({
            where: { orgId: actor.orgId }
          });
          const stores = await tx.businessStore.findMany({ where: { orgId: actor.orgId } });
          const rows = parsed.reviews
            .map((row, index) => {
              const identity = normalizeEnterpriseIdentity(row.enterpriseName);
              if (
                !enterprises.some(
                  (e) =>
                    e.enterpriseKey === identity.enterpriseKey &&
                    e.enterpriseName === identity.enterpriseName
                ) ||
                !stores.some(
                  (s) =>
                    s.enterpriseKey === identity.enterpriseKey &&
                    s.name === row.storeName &&
                    !s.retired
                )
              )
                throw new StoreReviewRepositoryError("STORE_REVIEW_IDENTITY_NOT_AVAILABLE");
              return {
                input: row,
                index,
                enterpriseKey: identity.enterpriseKey,
                source: row.source,
                storeName: row.storeName,
                reviewerName: row.reviewerName,
                reviewedAt: new Date(row.reviewedAt)
              };
            })
            .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
          const existingRows: StoreReview[] = [];
          for (let offset = 0; offset < rows.length; offset += 100)
            existingRows.push(
              ...(await tx.storeReview.findMany({
                where: {
                  orgId: actor.orgId,
                  OR: rows.slice(offset, offset + 100).map((row) => ({
                    enterpriseKey: row.enterpriseKey,
                    source: row.source,
                    storeName: row.storeName,
                    reviewerName: row.reviewerName,
                    reviewedAt: row.reviewedAt
                  }))
                }
              }))
            );
          // Prisma's object JSON codec can discard own __proto__ keys. Keep scores
          // as parameterized JSON text on both sides of the persistence boundary.
          for (let offset = 0; offset < existingRows.length; offset += 100) {
            const chunk = existingRows.slice(offset, offset + 100);
            const stored = await tx.$queryRawUnsafe<Array<{ id: string; scores: string | null }>>(
              `SELECT id, CAST(scores AS CHAR CHARACTER SET utf8mb4) AS scores FROM store_reviews WHERE org_id = ? AND id IN (${chunk.map(() => "?").join(",")})`,
              actor.orgId,
              ...chunk.map((row) => row.id)
            );
            const scoresById = new Map(
              stored.map((row) => [row.id, row.scores === null ? null : JSON.parse(row.scores)])
            );
            for (const row of chunk) row.scores = scoresById.get(row.id) ?? null;
          }
          const existingByKey = new Map(existingRows.map((row) => [key(row), row]));
          // Validate every merged row before any write; a contradiction aborts the whole batch.
          const resolvedRows = rows.map((row) => {
            try {
              return {
                ...row,
                input: {
                  ...row.input,
                  ...resolveStoreReviewReplyState(existingByKey.get(key(row)) ?? null, row.input)
                }
              };
            } catch (error) {
              if (error instanceof StoreReviewValidationError)
                throw new StoreReviewValidationError(error.message, {
                  ...error.details,
                  index: row.index
                });
              throw error;
            }
          });
          const result: StoreReviewWriteResult = {
            received: rows.length,
            inserted: 0,
            updated: 0,
            unchanged: 0
          };
          for (const row of resolvedRows) {
            const existing = existingByKey.get(key(row));
            if (existing && !changed(existing, row.input)) {
              result.unchanged++;
              continue;
            }
            try {
              const id = existing?.id ?? randomUUID().replaceAll("-", "");
              if (existing) {
                await tx.storeReview.update({ where: { id }, data: patch(row.input) });
                result.updated++;
              } else {
                await tx.storeReview.create({
                  data: {
                    id,
                    orgId: actor.orgId,
                    enterpriseKey: row.enterpriseKey,
                    source: row.source,
                    storeName: row.storeName,
                    reviewerName: row.reviewerName,
                    reviewedAt: row.reviewedAt,
                    content: row.input.content ?? null,
                    merchantReply: row.input.merchantReply ?? null,
                    replyStatus: row.input.replyStatus,
                    scores: Prisma.DbNull
                  }
                });
                result.inserted++;
              }
              if (Object.hasOwn(row.input, "scores") && row.input.scores !== null)
                await tx.$executeRaw`UPDATE store_reviews SET scores = ${JSON.stringify(row.input.scores)} WHERE org_id = ${actor.orgId} AND id = ${id}`;
              await persistStoreReviewResource(
                tx,
                {
                  orgId: actor.orgId,
                  actorId: actor.id,
                  reviewId: id,
                  enterpriseKey: row.enterpriseKey,
                  storeName: row.storeName
                },
                state,
                category
              );
            } catch (error) {
              const code =
                error instanceof ResourceAttributesError ||
                error instanceof StoreReviewRepositoryError
                  ? error.code
                  : "STORE_REVIEW_WRITE_FAILED";
              throw new StoreReviewRepositoryError(code, { index: row.index });
            }
          }
          await tx.auditLog.create({
            data: {
              orgId: actor.orgId,
              actorEmployeeId: actor.id,
              action: "store_reviews.upsert",
              targetType: "store_review_batch",
              result: "succeeded",
              metadata: { ...result }
            }
          });
          return result;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 120000 }
      );
    }
  };
}
