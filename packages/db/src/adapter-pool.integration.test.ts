import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createDatabaseAdapter } from "./adapter.js";

describe.skipIf(process.env["RUN_DATABASE_PROTOCOL_INTEGRATION"] !== "1")(
  "shared database pools",
  () => {
    function localUrl() {
      const url = new URL(process.env["DATABASE_URL"] ?? "");
      if (!["localhost", "127.0.0.1"].includes(url.hostname))
        throw new Error("Pool lifecycle tests require local MySQL");
      return url;
    }

    it("shares concurrent clients and keeps remaining owners connected until the last release", async () => {
      const url = localUrl().toString();
      const factory = createDatabaseAdapter(url);
      const [first, second] = await Promise.all([
        factory.connect(),
        createDatabaseAdapter(url).connect()
      ]);
      const query = { sql: "SELECT 42", args: [], argTypes: [] };
      try {
        expect(first.underlyingDriver() === second.underlyingDriver()).toBe(true);
        await first.dispose();
        await first.dispose();
        expect((await second.queryRaw(query)).rows).toEqual([["42"]]);
        await second.dispose();
        expect(second.underlyingDriver().totalConnections()).toBe(0);

        const reconnected = await factory.connect();
        try {
          expect(reconnected.underlyingDriver() === first.underlyingDriver()).toBe(false);
          expect((await reconnected.queryRaw(query)).rows).toEqual([["42"]]);
        } finally {
          await reconnected.dispose();
        }
      } finally {
        await Promise.all([first.dispose(), second.dispose()]);
      }
    });

    it("reclaims idle connections and isolates clients using different databases", async () => {
      const url = localUrl();
      // Shorten the real driver's idle timeout; the application must allow zero idle connections.
      url.searchParams.set("idleTimeout", "1");
      const otherUrl = new URL(url);
      otherUrl.pathname = "/information_schema";
      const first = await createDatabaseAdapter(url.toString()).connect();
      const other = await createDatabaseAdapter(otherUrl.toString()).connect();
      try {
        expect(first.underlyingDriver() === other.underlyingDriver()).toBe(false);
        expect(
          (await other.queryRaw({ sql: "SELECT DATABASE()", args: [], argTypes: [] })).rows
        ).toEqual([["information_schema"]]);
        await vi.waitFor(() => expect(first.underlyingDriver().totalConnections()).toBe(0), {
          interval: 100,
          timeout: 4000
        });
        expect((await first.queryRaw({ sql: "SELECT 7", args: [], argTypes: [] })).rows).toEqual([
          ["7"]
        ]);
      } finally {
        await Promise.all([first.dispose(), other.dispose()]);
      }
    });

    it("preserves Prisma transaction isolation and another client's lifetime on disconnect", async () => {
      const url = localUrl().toString();
      const first = new PrismaClient({ adapter: createDatabaseAdapter(url) });
      const second = new PrismaClient({ adapter: createDatabaseAdapter(url) });
      try {
        await Promise.all([first.$connect(), second.$connect()]);
        await first.$transaction(async (tx) => {
          const [inside] = await tx.$queryRaw<Array<{ id: number }>>`SELECT CONNECTION_ID() AS id`;
          const [outside] = await second.$queryRaw<
            Array<{ id: number }>
          >`SELECT CONNECTION_ID() AS id`;
          expect(inside!.id).not.toBe(outside!.id);
        });
        await first.$disconnect();
        expect(await second.$queryRaw`SELECT 42 AS answer`).toEqual([{ answer: 42n }]);
        expect(await first.$queryRaw`SELECT 7 AS answer`).toEqual([{ answer: 7n }]);
      } finally {
        await Promise.all([first.$disconnect(), second.$disconnect()]);
      }
    });
  }
);
