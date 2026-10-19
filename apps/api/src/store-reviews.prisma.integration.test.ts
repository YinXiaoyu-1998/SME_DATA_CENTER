import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ReadBuffer } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { jsonToolResult } from "@smedc/mcp-contract";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createDatabaseAdapter,
  createBusinessAuthorizationRepository,
  createPrismaStoreReviewRepository
} from "@smedc/db";
import type { AuthenticatedEmployee } from "@smedc/domain";
import { createLauncherRuntimeConfig } from "../../mcp-launcher/src/config.js";
import {
  createLauncherToolDependencies,
  createLauncherToolHandler
} from "../../mcp-launcher/src/launcher.js";
import { createStoreReviewService } from "./store-reviews.js";
import { buildApiServer } from "./server.js";
import { createBusinessAuthorizationService } from "./business-authorization.js";

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
(run ? describe : describe.skip)("launcher/MCP/HTTP store review MySQL path", () => {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(url) });
  const orgId = `review_api_${randomUUID().slice(0, 8)}`;
  const id = `${orgId}_admin`;
  const employee: AuthenticatedEmployee = {
    id,
    orgId,
    organizationName: "Synthetic",
    displayName: "Synthetic",
    email: `${id}@example.invalid`,
    role: "admin",
    disabled: false,
    clearance: 3
  };
  const permissions = createBusinessAuthorizationRepository({ prisma });
  const app = buildApiServer({
    logger: false,
    runtimeEnv: { SMEDC_PUBLIC_ORIGIN: "https://reviews.example.invalid" },
    cursorSigningSecret: "synthetic-review-secret",
    authenticateAccessToken: async () => employee,
    businessAuthorizationService: createBusinessAuthorizationService(permissions),
    storeReviewService: createStoreReviewService({
      repository: createPrismaStoreReviewRepository({
        prisma,
        cursorSecret: "synthetic-review-secret"
      })
    })
  });
  const dependencies = createLauncherToolDependencies({
    config: createLauncherRuntimeConfig({ smedcBaseUrl: "https://reviews.example.invalid" }),
    auth: {
      login: async () => {
        throw new Error("not used");
      },
      logout: async () => ({ remoteRevocationConfirmed: true, localCredentialRemoved: true }),
      status: async () => ({ authenticated: true }),
      accessToken: async () => "synthetic-token",
      profile: async () => employee,
      invalidate: async () => undefined,
      selfCheck: async () => {
        throw new Error("not used");
      }
    },
    fetchImplementation: async (input, init) => {
      const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const response = await app.inject({
        method: (init?.method ?? "GET") as "GET" | "POST",
        url: target.pathname,
        headers: Object.fromEntries(new Headers(init?.headers)),
        ...(typeof init?.body === "string" ? { payload: init.body } : {}),
        remoteAddress: "127.0.0.1"
      });
      return new Response(
        response.statusCode === 204 || response.statusCode === 202 ? null : response.body,
        { status: response.statusCode, headers: response.headers as Record<string, string> }
      );
    }
  });
  const write = createLauncherToolHandler("upsert_store_reviews", dependencies);
  const query = createLauncherToolHandler("query_store_reviews", dependencies);
  const row = {
    enterpriseName: "合成企业",
    source: "美团评价",
    storeName: "合成门店😀",
    reviewerName: "用户😀",
    reviewedAt: "2026-10-17 13"
  };
  const body = (result: Awaited<ReturnType<typeof write>>) => JSON.parse(result.content[0]!.text);
  beforeAll(async () => {
    await prisma.organization.create({ data: { id: orgId, name: "Synthetic" } });
    await prisma.employee.create({
      data: {
        id,
        orgId,
        email: employee.email,
        displayName: employee.displayName,
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
    await prisma.businessEnterpriseIdentity.create({
      data: { orgId, enterpriseKey: "合成企业", enterpriseName: "合成企业" }
    });
    await prisma.businessStore.create({
      data: { orgId, enterpriseKey: "合成企业", name: row.storeName }
    });
    await permissions.configureAccount({
      orgId,
      actorId: id,
      employeeId: id,
      expectedVersion: "1",
      clearance: 3,
      grants: [
        {
          id: "review-api-grant",
          orgId,
          enterpriseKey: "合成企业",
          categoryIds: ["reviews"],
          ownership: "store",
          stores: { kind: "fixed", values: [row.storeName] },
          dimensions: {}
        }
      ]
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });
  it("preserves arbitrary scores and content while adding only a verified published reply", async () => {
    const scores = JSON.parse('{"__proto__":8,"constructor":7,"服务":9}');
    expect(body(await write({ reviews: [{ ...row, scores }] }))).toMatchObject({
      received: 1,
      inserted: 1
    });
    const first = body(await query({ enterpriseName: row.enterpriseName }));
    const stored = await prisma.$queryRaw<
      Array<{ scores: string }>
    >`SELECT CAST(scores AS CHAR CHARACTER SET utf8mb4) AS scores FROM store_reviews WHERE org_id = ${orgId}`;
    expect(JSON.parse(stored[0]!.scores)).toEqual(scores);
    expect(first.rows[0]).toMatchObject({
      content: null,
      merchantReply: null,
      replyStatus: "needs_verification",
      scores,
      reviewedAt: "2026-10-17T13:00:00+08:00"
    });
    expect(Object.hasOwn(first.rows[0].scores, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(first.rows[0].scores)).toBe(Object.prototype);
    expect(body(await write({ reviews: [{ ...row, scores }] }))).toMatchObject({ unchanged: 1 });
    expect(body(await write({ reviews: [{ ...row, content: "已核实正文" }] }))).toMatchObject({
      updated: 1
    });
    expect(
      body(await write({ reviews: [{ ...row, merchantReply: "已在平台发布并核验的回复" }] }))
    ).toMatchObject({ updated: 1 });
    const second = body(await query({ enterpriseName: row.enterpriseName }));
    expect(second.rows[0]).toMatchObject({
      content: "已核实正文",
      scores,
      merchantReply: "已在平台发布并核验的回复"
    });
    expect(
      body(await write({ reviews: [{ ...row, merchantReply: "已在平台发布并核验的回复" }] }))
    ).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    expect(await prisma.storeReview.count({ where: { orgId } })).toBe(1);
    const card = body(await createLauncherToolHandler("get_my_permissions", dependencies)({}));
    expect(card.storeReviewEnterprises).toMatchObject({
      complete: true,
      read: [{ enterpriseName: "合成企业" }],
      write: [{ enterpriseName: "合成企业" }]
    });
  });
  it("returns safe HTTP 400 and MCP errors for merged status contradictions with no partial writes", async () => {
    await write({
      reviews: [
        {
          ...row,
          reviewerName: "status-existing",
          content: "Private customer body",
          replyStatus: "unreplied_with_content"
        }
      ]
    });
    const payload = {
      reviews: [
        { ...row, reviewerName: "status-new", replyStatus: "unreplied_no_content" },
        { ...row, reviewerName: "status-existing", replyStatus: "unreplied_no_content" }
      ]
    };
    const response = await app.inject({
      method: "POST",
      url: "/v1/store-reviews/upsert",
      headers: { authorization: "Bearer synthetic" },
      payload
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: "STORE_REVIEW_INVALID_INPUT",
      requestId: expect.any(String),
      details: { index: 1, field: "content" }
    });
    expect(response.body).not.toContain("Private customer body");
    const result = await write(payload);
    expect(result.isError).toBe(true);
    expect(body(result).error).toMatchObject({
      code: "STORE_REVIEW_INVALID_INPUT",
      requestId: expect.any(String)
    });
    expect(await prisma.storeReview.count({ where: { orgId, reviewerName: "status-new" } })).toBe(
      0
    );
    expect(
      await prisma.storeReview.findFirst({ where: { orgId, reviewerName: "status-existing" } })
    ).toMatchObject({ content: "Private customer body", replyStatus: "unreplied_with_content" });
  });
  it("round-trips all platform statuses and AND filters through launcher MCP and HTTP", async () => {
    const reviews = [
      {
        ...row,
        reviewerName: "platform-replied",
        content: null,
        merchantReply: "Published",
        replyStatus: "replied"
      },
      {
        ...row,
        reviewerName: "platform-no-content",
        content: null,
        merchantReply: "",
        replyStatus: "unreplied_no_content"
      },
      {
        ...row,
        reviewerName: "platform-with-content",
        content: "Body",
        merchantReply: null,
        replyStatus: "unreplied_with_content"
      },
      {
        ...row,
        reviewerName: "platform-unknown",
        merchantReply: "Recorded",
        replyStatus: "needs_verification"
      }
    ];
    expect(body(await write({ reviews }))).toMatchObject({ inserted: 4 });
    for (const review of reviews) {
      const result = await query({
        enterpriseName: row.enterpriseName,
        reviewerName: review.reviewerName,
        replyStatuses: [review.replyStatus]
      });
      expect(result.isError).not.toBe(true);
      expect(body(result).rows).toHaveLength(1);
      expect(body(result).rows[0]).toMatchObject({
        replyStatus: review.replyStatus,
        merchantReply: review.merchantReply
      });
    }
    const filtered = body(
      await query({
        enterpriseName: row.enterpriseName,
        replyStatuses: ["replied"],
        hasReply: false
      })
    );
    expect(filtered.rows).toEqual([]);
    expect(
      body(
        await write({
          reviews: [{ ...row, reviewerName: "platform-replied", scores: { 服务: 9 } }]
        })
      )
    ).toMatchObject({ updated: 1 });
    const retained = body(
      await query({ enterpriseName: row.enterpriseName, reviewerName: "platform-replied" })
    );
    expect(retained.rows[0]).toMatchObject({
      content: null,
      merchantReply: "Published",
      replyStatus: "replied",
      scores: { 服务: 9 }
    });
  });
  it("rolls back a valid earlier row when a later identity fails and uses current admin state", async () => {
    const result = await write({
      reviews: [
        { ...row, reviewerName: "rollback" },
        { ...row, storeName: "不存在门店", reviewerName: "bad" }
      ]
    });
    expect(result.isError).toBe(true);
    expect(body(result).error).toMatchObject({
      code: "STORE_REVIEW_IDENTITY_NOT_AVAILABLE",
      requestId: expect.any(String)
    });
    expect(await prisma.storeReview.count({ where: { orgId, reviewerName: "rollback" } })).toBe(0);
    await prisma.employee.update({ where: { id }, data: { role: "employee" } });
    const denied = await write({ reviews: [{ ...row, reviewerName: "demoted" }] });
    expect(body(denied).error.code).toBe("UPLOAD_ADMIN_REQUIRED");
    expect(await prisma.storeReview.count({ where: { orgId, reviewerName: "demoted" } })).toBe(0);
  });
  it("pages large full rows within the default SDK stdio output buffer without skipping rows", async () => {
    await prisma.employee.update({ where: { id }, data: { role: "admin" } });
    const content = '中\n"'.repeat(5_461);
    const scores = { ["维".repeat(16_000)]: 9 };
    const reviews = Array.from({ length: 100 }, (_, index) => ({
      ...row,
      reviewerName: `large-${index}`,
      reviewedAt: "2026-10-18 13",
      content,
      merchantReply: content,
      scores
    }));
    expect(body(await write({ reviews }))).toMatchObject({ inserted: 100 });
    const output = new PassThrough();
    const readBuffer = new ReadBuffer();
    let received = 0;
    let transportError: unknown;
    output.on("data", (chunk: Buffer) => {
      try {
        readBuffer.append(chunk);
        if (readBuffer.readMessage()) received++;
      } catch (error) {
        transportError = error;
      }
    });
    const transport = new StdioServerTransport(new PassThrough(), output);
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    try {
      do {
        const result = await query({
          enterpriseName: row.enterpriseName,
          reviewedAtFrom: "2026-10-18 00",
          limit: 200,
          ...(cursor ? { cursor } : {})
        });
        expect(result.isError).not.toBe(true);
        const data = body(result);
        if (pages === 0) {
          expect(data.rows.length).toBeLessThan(100);
          expect(data.page.nextCursor).toBeTypeOf("string");
          const all = {
            rows: [
              ...data.rows,
              ...Array.from({ length: 100 - data.rows.length }, () => data.rows[0])
            ],
            page: { nextCursor: null }
          };
          const oversized = Buffer.from(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: jsonToolResult(all) }) + "\n"
          );
          expect(oversized.length).toBeGreaterThan(10 * 1024 * 1024);
          expect(() => new ReadBuffer().append(oversized)).toThrow("maximum size");
        }
        await transport.send({ jsonrpc: "2.0", id: pages + 1, result });
        expect(transportError).toBeUndefined();
        for (const review of data.rows) {
          expect(seen.has(review.id)).toBe(false);
          seen.add(review.id);
          expect(review.content).toBe(content);
          expect(review.merchantReply).toBe(content);
          expect(review.scores).toEqual(scores);
        }
        pages++;
        cursor = data.page.nextCursor ?? undefined;
      } while (cursor);
      expect(pages).toBeGreaterThan(1);
      expect(seen.size).toBe(100);
      expect(received).toBe(pages);
    } finally {
      await transport.close();
    }
  });
});
