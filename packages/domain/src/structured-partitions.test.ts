import { describe, expect, test } from "vitest";
import {
  PartitionContractError,
  normalizeEnterpriseIdentity,
  partitionStoreIdentity
} from "./structured-partitions.js";

describe("structured partition identity", () => {
  test("normalizes enterprise display text without changing non-ASCII case", () => {
    expect(normalizeEnterpriseIdentity("  麦家  小馆  A  ")).toEqual({
      enterpriseKey: "麦家 小馆 a",
      enterpriseName: "麦家 小馆 A"
    });
  });

  test("prefers merchant IDs and preserves leading zeroes", () => {
    expect(partitionStoreIdentity({ merchantId: " 000123 ", storeName: " 门店 A " })).toEqual({
      storeKey: "merchant:000123",
      merchantId: "000123",
      storeName: "门店 A"
    });
  });

  test("falls back to a normalized store name when merchant ID is blank", () => {
    expect(partitionStoreIdentity({ merchantId: " ", storeName: "  Store   A  " })).toEqual({
      storeKey: "name:store a",
      merchantId: null,
      storeName: "Store A"
    });
  });

  test("rejects rows without either stable store identity", () => {
    expect(() => partitionStoreIdentity({ merchantId: null, storeName: "  " })).toThrowError(
      expect.objectContaining<Partial<PartitionContractError>>({
        code: "PARTITION_STORE_IDENTITY_MISSING"
      })
    );
  });
});
