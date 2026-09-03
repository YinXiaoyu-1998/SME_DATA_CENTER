import { describe, expect, it, vi } from "vitest";
import { databaseErrorDetails, retryIdempotentDatabaseOperation } from "./retry.js";

describe("database error diagnostics", () => {
  it("keeps only safe codes and does not retry unrelated P2039 errors", async () => {
    const error = {
      code: "P2039",
      message: "mysql://user:secret@host/database",
      sql: "private SQL",
      meta: {
        driverAdapterError: {
          cause: { originalCode: "1146", state: "42S02", originalMessage: "private SQL" }
        }
      }
    };
    expect(databaseErrorDetails(error)).toEqual({
      code: "P2039",
      mysqlCode: 1146,
      sqlState: "42S02"
    });
    const operation = vi.fn().mockRejectedValue(error);
    await expect(retryIdempotentDatabaseOperation(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
