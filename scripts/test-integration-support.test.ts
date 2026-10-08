import { describe, expect, it } from "vitest";
import { integrationDatabasePlan } from "./test-integration-support.js";

describe("fresh integration schema safety", () => {
  it("creates unique schema identities while preserving the loopback connection", () => {
    const first = integrationDatabasePlan("mysql://smedc@localhost:3307/smedc", "3307");
    const second = integrationDatabasePlan("mysql://smedc@localhost:3307/smedc", "3307");
    expect(first.schema).toMatch(/^smedc_integration_[a-f0-9]{32}$/);
    expect(second.schema).not.toBe(first.schema);
    expect(new URL(first.databaseUrl).pathname).toBe(`/${first.schema}`);
    expect(new URL(first.databaseUrl).hostname).toBe("localhost");
  });
  it.each([
    "mysql://smedc@remote.invalid:3307/smedc",
    "mysql://smedc@localhost:3306/smedc",
    "mysql://smedc@localhost:3307/smedc?host=remote.invalid",
    "mysql://smedc@localhost:3307/smedc?connectionLimit=10",
    "mysql://smedc@localhost:3307/smedc#override",
    "postgresql://smedc@localhost:3307/smedc",
    "mysql://smedc@localhost:3307/unsafe-name",
    "invalid"
  ])("rejects an unsafe connection without echoing it", (url) => {
    expect(() => integrationDatabasePlan(url, "3307")).toThrow(/Integration database/);
    try {
      integrationDatabasePlan(url, "3307");
    } catch (error) {
      expect(String(error)).not.toContain(url);
    }
  });
});
