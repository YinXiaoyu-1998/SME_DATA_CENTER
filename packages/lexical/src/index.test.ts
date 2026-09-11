import { describe, expect, it } from "vitest";
import {
  LEXICAL_TOKENIZER_NAME,
  lexicalStopwords,
  sparseVectorFromText,
  tokenizeForSparseVector
} from "./index.js";

describe("lexical tokenizer", () => {
  it("segments Chinese prose into words instead of one long run", () => {
    const tokens = tokenizeForSparseVector("门店后厨卫生规范");

    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens).toContain("门店");
    expect(tokens).toContain("卫生");
    expect(tokens).toContain("规范");
  });

  it("matches shared words across different Chinese phrasings", () => {
    const document = tokenizeForSparseVector("后厨卫生规范要求：每日清洁地面与操作台。");
    const query = tokenizeForSparseVector("后厨卫生");

    expect(query.length).toBeGreaterThan(0);
    expect(query.filter((token) => document.includes(token)).length).toBeGreaterThan(0);
    expect(document).toContain("卫生");
  });

  it("keeps latin, numeric, and standard-number tokens in their original shape", () => {
    expect(tokenizeForSparseVector("GB 31654-2021 食品安全国家标准")).toEqual([
      "gb",
      "31654",
      "2021",
      "食品安全",
      "国家标准"
    ]);
    expect(tokenizeForSparseVector("Kitchen Temperature 75°C")).toEqual([
      "kitchen",
      "temperature",
      "75",
      "c"
    ]);
  });

  it("drops punctuation, whitespace, and stop words", () => {
    const tokens = tokenizeForSparseVector("这是一份关于后厨的规范，并且我们需要遵守它。");

    expect(tokens).not.toContain("，");
    expect(tokens).not.toContain("。");
    expect(tokens).not.toContain("的");
    expect(tokens).not.toContain("是");
    expect(tokens).not.toContain("并且");
    expect(tokens).toContain("厨");
    expect(tokens).toContain("规范");
  });

  it("keeps single Chinese characters that carry meaning", () => {
    expect(tokenizeForSparseVector("店")).toEqual(["店"]);
    expect(tokenizeForSparseVector("油温")).toContain("油温");
  });

  it("returns no tokens for empty and separator-only input", () => {
    expect(tokenizeForSparseVector("")).toEqual([]);
    expect(tokenizeForSparseVector("   ")).toEqual([]);
    expect(tokenizeForSparseVector("，。！ ")).toEqual([]);
  });

  it("is deterministic and case insensitive", () => {
    expect(tokenizeForSparseVector("Kitchen Clean")).toEqual(
      tokenizeForSparseVector("kitchen clean")
    );
    expect(tokenizeForSparseVector("门店卫生")).toEqual(tokenizeForSparseVector("门店卫生"));
  });

  it("builds identical sparse vectors for the index path and the query path", () => {
    const text = "后厨卫生规范要求每日清洁地面";
    const first = sparseVectorFromText(text);
    const second = sparseVectorFromText(text);

    expect(first).toEqual(second);
    expect(first.indices.length).toBeGreaterThan(1);
    expect(first.indices).toEqual([...first.indices].sort((left, right) => left - right));
    expect(first.values.every((value) => value >= 1)).toBe(true);
  });

  it("keeps the tokenizer marker and stop-word list inspectable", () => {
    expect(LEXICAL_TOKENIZER_NAME).toBe("segmentit-dict-v1");
    expect(lexicalStopwords()).toContain("的");
  });
});
