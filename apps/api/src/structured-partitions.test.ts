import { describe, expect, test } from "vitest";
import {
  decidePartitionReplacement,
  partitionIdentityWhere,
  type CurrentPartitionState,
  type PartitionCandidate
} from "./structured-partitions.js";

const current: CurrentPartitionState = {
  id: "part_current",
  objectKey: "structured-partitions/org/job/current.csv",
  checksumSha256: "a".repeat(64),
  confidentialityLevel: 2,
  enterpriseName: "麦家小馆",
  merchantId: "000123",
  storeName: "门店 A",
  rowCount: 10n,
  byteSize: 100n
};

const candidate: PartitionCandidate = {
  id: "part_candidate",
  orgId: "org_1",
  enterpriseKey: "麦家小馆",
  enterpriseName: "麦家小馆",
  dataset: "dishes",
  storeKey: "merchant:000123",
  merchantId: "000123",
  storeName: "门店 A",
  businessDate: "2026-09-07",
  objectKey: "structured-partitions/org/job/candidate.csv",
  checksumSha256: "a".repeat(64),
  confidentialityLevel: 2,
  rowCount: 10n,
  byteSize: 100n
};

describe("partition publication decisions", () => {
  test("keeps identical current bytes and metadata and discards the candidate object", () => {
    expect(decidePartitionReplacement(current, candidate)).toEqual({
      action: "keep",
      objectKey: current.objectKey,
      garbageObjectKeys: [candidate.objectKey]
    });
  });

  test("reuses identical bytes while allowing confidentiality and display metadata replacement", () => {
    expect(
      decidePartitionReplacement(current, {
        ...candidate,
        confidentialityLevel: 0,
        enterpriseName: "麦家 小馆",
        storeName: "门店 A 新名"
      })
    ).toEqual({
      action: "update_metadata",
      objectKey: current.objectKey,
      garbageObjectKeys: [candidate.objectKey]
    });
  });

  test("publishes different bytes and schedules only the old object for deletion", () => {
    expect(
      decidePartitionReplacement(current, {
        ...candidate,
        checksumSha256: "b".repeat(64),
        byteSize: 101n
      })
    ).toEqual({
      action: "replace",
      objectKey: candidate.objectKey,
      garbageObjectKeys: [current.objectKey]
    });
  });

  test("builds the complete organization and enterprise scoped identity", () => {
    expect(partitionIdentityWhere(candidate)).toEqual({
      orgId: "org_1",
      enterpriseKey: "麦家小馆",
      dataset: "dishes",
      storeKey: "merchant:000123",
      businessDate: new Date("2026-09-07T00:00:00.000Z")
    });
  });
});
