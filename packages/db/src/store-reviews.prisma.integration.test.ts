import { randomUUID } from "node:crypto";
import { PrismaClient, Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createBusinessAuthorizationRepository } from "./business-authorization.js";
import {
  createStructuredCursor,
  hashStoreReviewQueryScope,
  parseStoreReviewQuery,
  parseStoreReviewBatch
} from "@smedc/domain";
import { createDatabaseAdapter } from "./adapter.js";
import { createPrismaStoreReviewRepository } from "./store-reviews.js";
const run = process.env["RUN_STORE_REVIEW_PRISMA_INTEGRATION"] === "1";
const url = process.env["DATABASE_URL"] ?? "";
if (run) {
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    !/^\/smedc_integration_[a-f0-9]{32}$/.test(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("Review tests require runner-owned loopback schema");
}
export const reviewIntegrationSuite = run ? describe : describe.skip;
reviewIntegrationSuite("store reviews transactional MySQL repository", () => {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(url) });
  const repo = createPrismaStoreReviewRepository({ prisma, cursorSecret: "synthetic-secret" });
  let orgId: string, id: string;
  const row = (reviewerName = "用户😀") => ({
    enterpriseName: "企业A",
    source: "美团评价" as const,
    storeName: "A店😀",
    reviewedAt: "2026-10-17 13",
    reviewerName
  });
  const actor = () => ({ orgId, id });
  beforeEach(async () => {
    orgId = `review_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    id = `${orgId}_admin`;
    await prisma.organization.create({ data: { id: orgId, name: "Synthetic reviews" } });
    await prisma.employee.create({
      data: {
        orgId,
        id,
        email: `${id}@example.invalid`,
        displayName: "Admin",
        role: "admin",
        clearance: 3
      }
    });
    await prisma.businessAuthorizationState.create({
      data: { orgId, mode: "enabled", version: 1n }
    });
    await prisma.businessCategory.create({
      data: {
        orgId,
        id: "reviews",
        key: "store_reviews",
        name: "Reviews",
        kind: "fixed",
        confidentialityLevel: 2,
        allowGroup: false,
        allowStore: true
      }
    });
    await prisma.businessEnterpriseIdentity.createMany({
      data: ["企业A", "企业B"].map((enterpriseName) => ({
        orgId,
        enterpriseName,
        enterpriseKey: enterpriseName.replace("A", "a").replace("B", "b")
      }))
    });
    await prisma.businessStore.createMany({
      data: ["企业a", "企业b"].flatMap((enterpriseKey) =>
        ["A店😀", "A店😀 ", "a店😀", "B店"].map((name) => ({ orgId, enterpriseKey, name }))
      )
    });
  });
  afterAll(() => prisma.$disconnect());
  async function grants(stores = ["A店😀"], enterpriseKey = "企业a") {
    const permissions = createBusinessAuthorizationRepository({ prisma });
    const state = await prisma.businessAuthorizationState.findUniqueOrThrow({ where: { orgId } });
    await permissions.configureAccount({
      orgId,
      actorId: id,
      employeeId: id,
      expectedVersion: state.version.toString(),
      clearance: 3,
      grants: [
        {
          orgId,
          id: "review-grant",
          enterpriseKey,
          categoryIds: ["reviews"],
          ownership: "store",
          stores: { kind: "fixed", values: stores },
          dimensions: {}
        }
      ]
    });
  }
  it("filters complete grants before pagination with no administrator read bypass", async () => {
    await repo.upsert(actor(), {
      reviews: [
        row("first"),
        row("second"),
        { ...row("neighbor"), storeName: "B店", reviewedAt: "2026-10-18 13" },
        { ...row("other enterprise"), enterpriseName: "企业B", reviewedAt: "2026-10-19 13" }
      ]
    });
    await expect(repo.query(actor(), { enterpriseName: "企业A" })).rejects.toThrow(
      "STORE_REVIEW_ACCESS_DENIED"
    );
    await grants();
    const first = await repo.query(actor(), { enterpriseName: "企业A", limit: 1 });
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({
      enterpriseName: "企业A",
      storeName: "A店😀",
      reviewedAt: "2026-10-17T13:00:00+08:00",
      scores: null
    });
    expect(first.page.nextCursor).not.toBeNull();
    const second = await repo.query(actor(), {
      enterpriseName: "企业A",
      limit: 1,
      cursor: first.page.nextCursor!
    });
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]!.id).not.toBe(first.rows[0]!.id);
    expect(second.page.nextCursor).toBeNull();
    await expect(repo.query(actor(), { enterpriseName: "企业B" })).rejects.toThrow(
      "STORE_REVIEW_ACCESS_DENIED"
    );
    expect(
      (await repo.query(actor(), { enterpriseName: "企业A", storeNames: ["B店"] })).rows
    ).toEqual([]);
    await prisma.employee.update({ where: { id }, data: { clearance: 1 } });
    await expect(repo.query(actor(), { enterpriseName: "企业A" })).rejects.toThrow(
      "STORE_REVIEW_ACCESS_DENIED"
    );
  });
  it("does not assemble category and store access from different grants", async () => {
    await repo.upsert(actor(), { reviews: [row(), { ...row("neighbor"), storeName: "B店" }] });
    await prisma.businessCategory.create({
      data: {
        orgId,
        id: "business",
        key: "business",
        name: "Business",
        kind: "fixed",
        confidentialityLevel: 0,
        allowGroup: false,
        allowStore: true
      }
    });
    const permissions = createBusinessAuthorizationRepository({ prisma });
    const state = await prisma.businessAuthorizationState.findUniqueOrThrow({ where: { orgId } });
    await permissions.configureAccount({
      orgId,
      actorId: id,
      employeeId: id,
      expectedVersion: state.version.toString(),
      clearance: 3,
      grants: [
        {
          orgId,
          id: "one",
          enterpriseKey: "企业a",
          categoryIds: ["reviews"],
          ownership: "store",
          stores: { kind: "fixed", values: ["B店"] },
          dimensions: {}
        },
        {
          orgId,
          id: "two",
          enterpriseKey: "企业a",
          categoryIds: ["business"],
          ownership: "store",
          stores: { kind: "fixed", values: ["A店😀"] },
          dimensions: {}
        }
      ]
    });
    expect(
      (await repo.query(actor(), { enterpriseName: "企业A" })).rows.map((r) => r.storeName)
    ).toEqual(["B店"]);
  });
  it("binds exact filters, inclusive time ranges and null/empty reply semantics", async () => {
    await repo.upsert(actor(), {
      reviews: [
        { ...row("null"), content: "" },
        { ...row("empty"), merchantReply: "", source: "点评评价" },
        { ...row("published"), merchantReply: " ", reviewedAt: "2026-10-17 13:30:12" },
        { ...row("' OR 1=1 --"), merchantReply: "reply", reviewedAt: "2026-10-18 13" }
      ]
    });
    await grants();
    expect(
      (await repo.query(actor(), { enterpriseName: "企业A", hasReply: false })).rows
    ).toHaveLength(2);
    expect(
      (await repo.query(actor(), { enterpriseName: "企业A", hasReply: true })).rows
    ).toHaveLength(2);
    expect(
      (await repo.query(actor(), { enterpriseName: "企业A", sources: ["点评评价"] })).rows.map(
        (r) => r.reviewerName
      )
    ).toEqual(["empty"]);
    expect(
      (
        await repo.query(actor(), {
          enterpriseName: "企业A",
          reviewedAtFrom: "2026-10-17 13:30:12",
          reviewedAtTo: "2026-10-17T13:30:12+08:00"
        })
      ).rows.map((r) => r.reviewerName)
    ).toEqual(["published"]);
    expect(
      (
        await repo.query(actor(), { enterpriseName: "企业A", reviewerName: "' OR 1=1 --" })
      ).rows.map((r) => r.reviewerName)
    ).toEqual(["' OR 1=1 --"]);
  });
  it("rejects changed identity/filter/version and expired or tampered cursors", async () => {
    await repo.upsert(actor(), { reviews: [row("one"), row("two")] });
    await grants();
    const input = { enterpriseName: "企业A", limit: 1 };
    const first = await repo.query(actor(), input);
    const cursor = first.page.nextCursor!;
    await expect(repo.query(actor(), { ...input, cursor, hasReply: false })).rejects.toThrow(
      /Cursor/
    );
    await expect(
      repo.query(actor(), { ...input, cursor: cursor.slice(0, -5) + "bad" })
    ).rejects.toThrow(/Cursor/);
    const state = await prisma.businessAuthorizationState.findUniqueOrThrow({ where: { orgId } });
    const expired = createStructuredCursor({
      offset: 1,
      shapeHash: hashStoreReviewQueryScope({
        orgId,
        employeeId: id,
        enterpriseKey: "企业a",
        authorizationVersion: state.version.toString(),
        query: parseStoreReviewQuery(input)
      }),
      secret: "synthetic-secret",
      now: new Date(Date.now() - 901000)
    });
    await expect(repo.query(actor(), { ...input, cursor: expired })).rejects.toThrow(/expired/);
    await repo.upsert(actor(), { reviews: [{ ...row("one"), merchantReply: "published" }] });
    await expect(repo.query(actor(), { ...input, cursor })).rejects.toThrow(/Cursor/);
    const refreshed = await repo.query(actor(), input);
    await grants(["B店"]);
    await expect(
      repo.query(actor(), { ...input, cursor: refreshed.page.nextCursor! })
    ).rejects.toThrow(/Cursor/);
    expect((await repo.query(actor(), input)).rows).toEqual([]);
  });
  it("preserves omitted fields, null, empty scores and no-op timestamps", async () => {
    const input = {
      reviews: [{ ...row(), content: "正文", scores: { 服务: 8 }, merchantReply: "已发布回复" }]
    };
    expect(await repo.upsert(actor(), input)).toEqual({
      received: 1,
      inserted: 1,
      updated: 0,
      unchanged: 0
    });
    const original = await prisma.storeReview.findFirstOrThrow({ where: { orgId } });
    expect(
      await repo.upsert(actor(), { reviews: [{ ...input.reviews[0]!, scores: { 服务: 8 } }] })
    ).toMatchObject({ unchanged: 1 });
    expect(await prisma.storeReview.findFirst({ where: { orgId } })).toEqual(original);
    await repo.upsert(actor(), { reviews: [{ ...row(), merchantReply: "新发布回复" }] });
    expect(await prisma.storeReview.findFirst({ where: { orgId } })).toMatchObject({
      content: "正文",
      scores: { 服务: 8 },
      merchantReply: "新发布回复"
    });
    await repo.upsert(actor(), {
      reviews: [{ ...row(), scores: {}, content: null, merchantReply: null }]
    });
    expect(await prisma.storeReview.findFirst({ where: { orgId } })).toMatchObject({
      content: null,
      scores: {},
      merchantReply: null
    });
    await repo.upsert(actor(), { reviews: [{ ...row(), scores: null }] });
    const rows = await prisma.$queryRaw<Array<{ isNull: bigint }>>(
      Prisma.sql`SELECT scores IS NULL AS isNull FROM store_reviews WHERE org_id = ${orgId}`
    );
    expect(Number(rows[0]!.isNull)).toBe(1);
  });
  it("uses exact Unicode, case, trailing space, source and enterprise uniqueness", async () => {
    const reviews = [
      row(),
      { ...row(), storeName: "A店😀 " },
      { ...row(), storeName: "a店😀" },
      { ...row(), source: "点评评价" as const },
      { ...row(), enterpriseName: "企业B" },
      { ...row(), reviewerName: "用户😀 " }
    ];
    expect(await repo.upsert(actor(), { reviews })).toMatchObject({ inserted: 6 });
    expect(await prisma.businessResource.count({ where: { orgId, kind: "store_review" } })).toBe(6);
    expect(await prisma.businessResourceScope.count({ where: { orgId } })).toBe(6);
  });
  it("keeps the same business key independent across organizations", async () => {
    await repo.upsert(actor(), { reviews: [row()] });
    const otherOrg = orgId + "_other",
      otherId = id + "_2";
    await prisma.organization.create({ data: { id: otherOrg, name: "Synthetic isolated tenant" } });
    await prisma.employee.create({
      data: {
        orgId: otherOrg,
        id: otherId,
        email: `${otherId}@example.invalid`,
        displayName: "Admin",
        role: "admin",
        clearance: 3
      }
    });
    await prisma.businessAuthorizationState.create({
      data: { orgId: otherOrg, mode: "enabled", version: 1n }
    });
    await prisma.businessCategory.create({
      data: {
        orgId: otherOrg,
        id: "reviews",
        key: "store_reviews",
        name: "Reviews",
        kind: "fixed",
        confidentialityLevel: 2,
        allowGroup: false,
        allowStore: true
      }
    });
    await prisma.businessEnterpriseIdentity.create({
      data: { orgId: otherOrg, enterpriseName: "企业A", enterpriseKey: "企业a" }
    });
    await prisma.businessStore.create({
      data: { orgId: otherOrg, enterpriseKey: "企业a", name: "A店😀" }
    });
    expect(await repo.upsert({ orgId: otherOrg, id: otherId }, { reviews: [row()] })).toMatchObject(
      { inserted: 1 }
    );
    await expect(
      repo.upsert({ orgId: otherOrg, id }, { reviews: [row("cross-org")] })
    ).rejects.toThrow("UPLOAD_ADMIN_REQUIRED");
    expect(await prisma.storeReview.count({ where: { orgId: { in: [orgId, otherOrg] } } })).toBe(2);
  });
  it("stores full four-byte Unicode character boundaries without truncating", async () => {
    const content = "😀".repeat(16384),
      reviewerName = "😀".repeat(255);
    await repo.upsert(actor(), {
      reviews: [{ ...row(reviewerName), content, merchantReply: content }]
    });
    expect(await prisma.storeReview.findFirst({ where: { orgId } })).toMatchObject({
      reviewerName,
      content,
      merchantReply: content
    });
  });
  it("serializes concurrent patches and same-key inserts without losing absent fields", async () => {
    await Promise.all([
      repo.upsert(actor(), { reviews: [{ ...row(), content: "正文" }] }),
      repo.upsert(actor(), { reviews: [{ ...row(), scores: { x: 10 } }] })
    ]);
    expect(await prisma.storeReview.count({ where: { orgId } })).toBe(1);
    expect(await prisma.storeReview.findFirst({ where: { orgId } })).toMatchObject({
      content: "正文",
      scores: { x: 10 }
    });
    expect(await prisma.businessResource.count({ where: { orgId } })).toBe(1);
  });
  it("rejects current demoted or disabled admin and unconfigured/retired identities atomically", async () => {
    await prisma.employee.update({ where: { id }, data: { role: "employee" } });
    await expect(repo.upsert(actor(), { reviews: [row()] })).rejects.toThrow(
      "UPLOAD_ADMIN_REQUIRED"
    );
    await prisma.employee.update({ where: { id }, data: { role: "admin", disabled: true } });
    await expect(repo.upsert(actor(), { reviews: [row()] })).rejects.toThrow(
      "UPLOAD_ADMIN_REQUIRED"
    );
    await prisma.employee.update({ where: { id }, data: { disabled: false } });
    await expect(
      repo.upsert(actor(), { reviews: [row(), { ...row("other"), enterpriseName: "不存在" }] })
    ).rejects.toThrow("STORE_REVIEW_IDENTITY_NOT_AVAILABLE");
    await prisma.businessStore.updateMany({ where: { orgId }, data: { retired: true } });
    await expect(repo.upsert(actor(), { reviews: [row()] })).rejects.toThrow(
      "STORE_REVIEW_IDENTITY_NOT_AVAILABLE"
    );
    expect(await prisma.storeReview.count({ where: { orgId } })).toBe(0);
    expect(
      (await prisma.businessAuthorizationState.findUniqueOrThrow({ where: { orgId } })).version
    ).toBe(1n);
  });
  it("defaults unverified historical text and round-trips all four platform states", async () => {
    // Omitting the new column exercises the same database default applied to historical rows.
    await prisma.$executeRaw`INSERT INTO store_reviews (id, org_id, enterprise_key, source, store_name, reviewed_at, reviewer_name, merchant_reply, updated_at) VALUES ('historical', ${orgId}, '企业a', '美团评价', 'A店😀', '2026-10-17 05:00:00', 'historical', 'Recorded published reply', NOW(3))`;
    expect(await prisma.storeReview.findUnique({ where: { id: "historical" } })).toMatchObject({
      replyStatus: "needs_verification"
    });
    await repo.upsert(actor(), {
      reviews: [
        { ...row("replied"), content: null, merchantReply: " Published ", replyStatus: "replied" },
        {
          ...row("no-content"),
          content: " \t",
          merchantReply: "",
          replyStatus: "unreplied_no_content"
        },
        { ...row("with-content"), content: " Body ", replyStatus: "unreplied_with_content" },
        { ...row("unknown"), merchantReply: "Recorded", replyStatus: "needs_verification" }
      ]
    });
    await grants();
    const result = await repo.query(actor(), { enterpriseName: "企业A" });
    expect(result.rows.find((r) => r.reviewerName === "replied")).toMatchObject({
      content: null,
      merchantReply: " Published ",
      replyStatus: "replied"
    });
    expect(result.rows.find((r) => r.reviewerName === "no-content")).toMatchObject({
      content: " \t",
      merchantReply: "",
      replyStatus: "unreplied_no_content"
    });
    expect(result.rows.find((r) => r.reviewerName === "with-content")).toMatchObject({
      content: " Body ",
      merchantReply: null,
      replyStatus: "unreplied_with_content"
    });
    expect(result.rows.find((r) => r.reviewerName === "unknown")).toMatchObject({
      merchantReply: "Recorded",
      replyStatus: "needs_verification"
    });
  });
  it("counts status-only changes, preserves scoring patches, and downgrades conflicting legacy patches", async () => {
    await repo.upsert(actor(), { reviews: [{ ...row(), merchantReply: "Published" }] });
    expect(
      await repo.upsert(actor(), { reviews: [{ ...row(), replyStatus: "replied" }] })
    ).toMatchObject({ updated: 1, unchanged: 0 });
    const verified = await prisma.storeReview.findFirstOrThrow({ where: { orgId } });
    expect(
      await repo.upsert(actor(), { reviews: [{ ...row(), replyStatus: "replied" }] })
    ).toMatchObject({ updated: 0, unchanged: 1 });
    expect(await prisma.storeReview.findFirstOrThrow({ where: { orgId } })).toEqual(verified);
    await repo.upsert(actor(), { reviews: [{ ...row(), scores: { 服务: 9 } }] });
    expect(await prisma.storeReview.findFirst({ where: { orgId } })).toMatchObject({
      content: null,
      merchantReply: "Published",
      replyStatus: "replied",
      scores: { 服务: 9 }
    });
    await repo.upsert(actor(), {
      reviews: [
        { ...row(), content: "Body", merchantReply: null, replyStatus: "unreplied_with_content" }
      ]
    });
    await repo.upsert(actor(), { reviews: [{ ...row(), merchantReply: " New published " }] });
    expect(await prisma.storeReview.findFirst({ where: { orgId } })).toMatchObject({
      content: "Body",
      merchantReply: " New published ",
      replyStatus: "needs_verification"
    });
    await repo.upsert(actor(), { reviews: [{ ...row(), replyStatus: "replied" }] });
    await repo.upsert(actor(), { reviews: [{ ...row(), merchantReply: "" }] });
    expect(await prisma.storeReview.findFirst({ where: { orgId } })).toMatchObject({
      merchantReply: "",
      replyStatus: "needs_verification"
    });
  });
  it("validates all merged facts before writing and rolls back rows, resources, audit and version", async () => {
    await repo.upsert(actor(), {
      reviews: [
        { ...row("existing"), content: "Private body", replyStatus: "unreplied_with_content" }
      ]
    });
    const before = await prisma.storeReview.findMany({ where: { orgId } });
    const version = await prisma.businessAuthorizationState.findUniqueOrThrow({ where: { orgId } });
    const resources = await prisma.businessResource.findMany({ where: { orgId } });
    const auditCount = await prisma.auditLog.count({ where: { orgId } });
    await expect(
      repo.upsert(actor(), {
        reviews: [
          { ...row("aaa-new"), replyStatus: "unreplied_no_content" },
          { ...row("existing"), replyStatus: "unreplied_no_content" }
        ]
      })
    ).rejects.toMatchObject({
      code: "STORE_REVIEW_INVALID_INPUT",
      details: { index: 1, field: "content" }
    });
    expect(await prisma.storeReview.findMany({ where: { orgId } })).toEqual(before);
    expect(await prisma.businessResource.findMany({ where: { orgId } })).toEqual(resources);
    expect(await prisma.auditLog.count({ where: { orgId } })).toBe(auditCount);
    expect(await prisma.businessAuthorizationState.findUniqueOrThrow({ where: { orgId } })).toEqual(
      version
    );
  });
  it("filters platform statuses within authorized scope, ANDs text presence and invalidates cursors", async () => {
    await repo.upsert(actor(), {
      reviews: [
        { ...row("one"), replyStatus: "unreplied_no_content" },
        { ...row("two"), replyStatus: "unreplied_no_content" },
        { ...row("replied"), merchantReply: "Published", replyStatus: "replied" },
        { ...row("unknown"), merchantReply: "Recorded", replyStatus: "needs_verification" },
        { ...row("neighbor"), storeName: "B店", replyStatus: "unreplied_no_content" },
        { ...row("other enterprise"), enterpriseName: "企业B", replyStatus: "unreplied_no_content" }
      ]
    });
    await grants();
    expect(
      (
        await repo.query(actor(), {
          enterpriseName: "企业A",
          replyStatuses: ["needs_verification", "replied"],
          hasReply: true
        })
      ).rows
        .map((r) => r.reviewerName)
        .sort()
    ).toEqual(["replied", "unknown"]);
    expect(
      (
        await repo.query(actor(), {
          enterpriseName: "企业A",
          replyStatuses: ["needs_verification", "replied"],
          hasReply: false
        })
      ).rows
    ).toEqual([]);
    const query = {
      enterpriseName: "企业A",
      replyStatuses: ["unreplied_no_content" as const],
      limit: 1
    };
    const first = await repo.query(actor(), query);
    expect(first.rows[0]!.storeName).toBe("A店😀");
    const cursor = first.page.nextCursor!;
    expect(cursor).toBeTypeOf("string");
    await expect(
      repo.query(actor(), { ...query, cursor, replyStatuses: ["replied"] })
    ).rejects.toThrow(/Cursor/);
    await repo.upsert(actor(), { reviews: [{ ...row("one"), replyStatus: "needs_verification" }] });
    await expect(repo.query(actor(), { ...query, cursor })).rejects.toThrow(/Cursor/);
    const remaining = await repo.query(actor(), query);
    expect(remaining.rows.map((r) => r.reviewerName)).toEqual(["two"]);
    expect(remaining.page.nextCursor).toBeNull();
    await expect(
      repo.query(actor(), { enterpriseName: "企业B", replyStatuses: ["unreplied_no_content"] })
    ).rejects.toThrow("STORE_REVIEW_ACCESS_DENIED");
  });
  it("successfully persists a full 1000-row batch", async () => {
    const input = parseStoreReviewBatch({
      reviews: Array.from({ length: 1000 }, (_, i) => row(String(i).padStart(4, "0")))
    });
    expect(await repo.upsert(actor(), input)).toMatchObject({ received: 1000, inserted: 1000 });
    expect(await prisma.storeReview.count({ where: { orgId } })).toBe(1000);
    expect(await prisma.businessResourceScope.count({ where: { orgId } })).toBe(1000);
  }, 120000);
  it("rolls back all data/resources/version if the 1000th database insert fails", async () => {
    const trigger = `reviews_fail_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON store_reviews FOR EACH ROW BEGIN IF NEW.reviewer_name = '0999' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic failure'; END IF; END`
    );
    try {
      await expect(
        repo.upsert(actor(), {
          reviews: Array.from({ length: 1000 }, (_, i) => row(String(i).padStart(4, "0")))
        })
      ).rejects.toMatchObject({ code: "STORE_REVIEW_WRITE_FAILED", details: { index: 999 } });
      expect(await prisma.storeReview.count({ where: { orgId } })).toBe(0);
      expect(await prisma.businessResource.count({ where: { orgId } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { orgId } })).toBe(0);
      expect(
        (await prisma.businessAuthorizationState.findUniqueOrThrow({ where: { orgId } })).version
      ).toBe(1n);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER ${trigger}`);
    }
  }, 120000);
});
