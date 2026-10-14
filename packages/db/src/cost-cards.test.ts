import { describe, expect, it } from "vitest";
import { costCardBaselineMatches, costCardOperation } from "./cost-cards.js";

describe("cost card publication decisions", () => {
  const current = {
    id: "card",
    revision: 1n,
    contentHash: "hash",
    objectKey: "old",
    canonicalizationVersion: 1,
    csvSchemaVersion: 1,
    archivedAt: null
  };
  it("keeps same content, restores archived cards and fences every baseline field", () => {
    expect(costCardOperation(null, "hash", 1)).toBe("inserted");
    expect(costCardOperation(current, "hash", 1)).toBe("unchanged");
    expect(costCardOperation(current, "different", 1)).toBe("updated");
    expect(costCardOperation({ ...current, archivedAt: new Date() }, "hash", 1)).toBe("restored");
    expect(() => costCardOperation(current, "hash", 2)).toThrow("COST_CARD_VERSION_UNSUPPORTED");
    expect(costCardBaselineMatches(current, current)).toBe(true);
    expect(costCardBaselineMatches(current, { ...current, revision: 2n })).toBe(false);
    expect(costCardBaselineMatches(current, { ...current, archivedAt: new Date() })).toBe(false);
    expect(costCardBaselineMatches(null, current)).toBe(false);
  });
});
