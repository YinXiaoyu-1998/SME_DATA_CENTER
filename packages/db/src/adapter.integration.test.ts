import { describe, expect, it } from "vitest";
import { createDatabaseAdapter } from "./adapter.js";

// Run against RDS as well as local MySQL: the failure requires the RDS proxy.
describe.skipIf(process.env["RUN_DATABASE_PROTOCOL_INTEGRATION"] !== "1")(
  "database protocol",
  () => {
    it("preserves values across overlapping queries with different parameter counts", async () => {
      const adapter = await createDatabaseAdapter(process.env["DATABASE_URL"] ?? "").connect();
      const tx = await adapter.startTransaction();
      const value = "fixture'\\中文";
      const run = (sql: string, args: string[]) =>
        tx.queryRaw({
          sql,
          args,
          argTypes: args.map(() => ({
            scalarType: "string" as const,
            arity: "scalar" as const,
            dbType: "VARCHAR"
          }))
        });
      try {
        for (let i = 0; i < 100; i++) {
          const results = await Promise.allSettled([
            run("SELECT ? AS a", [value]).then(() => run("SELECT ? AS c", [value])),
            run("SELECT ? AS a, ? AS b", [value, value])
          ]);
          expect(results).toEqual([
            { status: "fulfilled", value: expect.objectContaining({ rows: [[value]] }) },
            { status: "fulfilled", value: expect.objectContaining({ rows: [[value, value]] }) }
          ]);
        }
      } finally {
        await tx.rollback();
        await adapter.dispose();
      }
    });
  }
);
