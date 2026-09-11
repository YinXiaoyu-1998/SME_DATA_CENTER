import { createHash } from "node:crypto";
import segmentit from "segmentit";

/**
 * Identifies the segmentation behaviour behind a stored sparse vector. Any change to the
 * segmentation mode, dictionary, or stop-word list must bump this marker so vectors produced by
 * an older tokenizer can be told apart from newer ones.
 */
export const LEXICAL_TOKENIZER_NAME = "segmentit-dict-v1";

export interface SparseTermVector {
  indices: number[];
  values: number[];
}

const TOKEN_SEPARATOR_PATTERN = /[^\p{L}\p{N}_]+/u;

/**
 * Function words that carry no retrieval signal in restaurant SOPs and business documents.
 * Segmentation keeps them in the token stream, so the lexical branch removes them explicitly.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // Chinese particles, pronouns, and conjunctions.
  "的",
  "了",
  "着",
  "过",
  "吗",
  "呢",
  "吧",
  "啊",
  "呀",
  "哦",
  "是",
  "在",
  "有",
  "和",
  "与",
  "及",
  "或",
  "等",
  "等等",
  "之",
  "其",
  "该",
  "此",
  "这",
  "那",
  "这个",
  "那个",
  "这些",
  "那些",
  "这样",
  "那样",
  "我",
  "你",
  "您",
  "他",
  "她",
  "它",
  "我们",
  "你们",
  "他们",
  "她们",
  "它们",
  "自己",
  "大家",
  "就",
  "也",
  "都",
  "很",
  "还",
  "又",
  "再",
  "才",
  "只",
  "更",
  "最",
  "太",
  "非常",
  "比较",
  "但",
  "但是",
  "而",
  "而且",
  "并",
  "并且",
  "不过",
  "然后",
  "因此",
  "所以",
  "因为",
  "由于",
  "如果",
  "假如",
  "若",
  "虽然",
  "尽管",
  "无论",
  "为了",
  "对于",
  "关于",
  "根据",
  "按照",
  "通过",
  "使用",
  "进行",
  "可以",
  "应该",
  "需要",
  "必须",
  "能够",
  "可能",
  "会",
  "要",
  "能",
  "把",
  "被",
  "让",
  "给",
  "到",
  "由",
  "从",
  "向",
  "往",
  "对",
  "于",
  "以",
  "上",
  "下",
  "中",
  "内",
  "外",
  "前",
  "后",
  "时",
  "时候",
  "一个",
  "一些",
  "一种",
  "什么",
  "怎么",
  "怎样",
  "如何",
  "哪个",
  "哪些",
  "为什么",
  "是否",
  "不",
  "没",
  "没有",
  "无",
  // English function words.
  "a",
  "an",
  "the",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "and",
  "or",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "with",
  "by",
  "from",
  "as",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "we",
  "you",
  "they",
  "he",
  "she",
  "not",
  "no",
  "if",
  "then",
  "than",
  "but",
  "also",
  "can",
  "will",
  "shall",
  "must",
  "should",
  "may",
  "might",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had"
]);

let segmenter: ReturnType<typeof segmentit.useDefault> | null = null;

function segment(): ReturnType<typeof segmentit.useDefault> {
  // Building the dictionary-backed segmenter costs about 100 ms, so it happens on first use.
  segmenter ??= segmentit.useDefault(new segmentit.Segment());

  return segmenter;
}

/**
 * Tokenizes text for the lexical (sparse vector) branch. The index side and the query side must
 * always call this function, because a mismatch between the two silently degrades lexical recall.
 */
export function tokenizeForSparseVector(text: string): string[] {
  const normalized = text.toLowerCase();

  if (normalized.trim().length === 0) {
    return [];
  }

  const tokens: string[] = [];

  for (const candidate of segment().doSegment(normalized, { simple: true })) {
    for (const piece of candidate.split(TOKEN_SEPARATOR_PATTERN)) {
      if (piece.length === 0 || STOPWORDS.has(piece)) {
        continue;
      }

      tokens.push(piece);
    }
  }

  return tokens;
}

/**
 * Builds the deterministic hash-based term-frequency sparse vector stored in Qdrant. The hashing
 * and index construction are unchanged from the previous implementation; only the tokenization
 * feeding it changed.
 */
export function sparseVectorFromText(text: string): SparseTermVector {
  const counts = new Map<number, number>();

  for (const token of tokenizeForSparseVector(text)) {
    const index = Number.parseInt(
      createHash("sha256").update(token, "utf8").digest("hex").slice(0, 7),
      16
    );
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }

  const entries = [...counts.entries()].sort((first, second) => first[0] - second[0]);

  return {
    indices: entries.map(([index]) => index),
    values: entries.map(([, count]) => count)
  };
}

export function lexicalStopwords(): readonly string[] {
  return [...STOPWORDS];
}
