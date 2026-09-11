import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  createPrismaEvidenceSectionExpander,
  sectionKeyFromHeadingPath,
  type EvidenceSectionCandidate
} from "./evidence-sections.js";

interface FakeRow {
  chunkIndex: number;
  chunkText: string;
  sectionHeadingPath: string[];
}

interface ChunkQueryRange {
  chunkIndex: { gte: number; lte: number };
}

function fakePrisma(rowsByDocumentIndex: Record<string, FakeRow[]>) {
  const queries: Array<{ documentIndexId: string; ranges: ChunkQueryRange[] }> = [];
  const prisma = {
    documentChunk: {
      findMany: async (args: { where: { documentIndexId: string; OR: ChunkQueryRange[] } }) => {
        queries.push({
          documentIndexId: args.where.documentIndexId,
          ranges: args.where.OR
        });

        return (rowsByDocumentIndex[args.where.documentIndexId] ?? [])
          .filter((row) =>
            args.where.OR.some(
              (range) =>
                row.chunkIndex >= range.chunkIndex.gte && row.chunkIndex <= range.chunkIndex.lte
            )
          )
          .map((row) => ({
            chunkIndex: row.chunkIndex,
            chunkText: row.chunkText,
            sourceLocation: { sectionHeadingPath: row.sectionHeadingPath }
          }));
      }
    }
  } as unknown as PrismaClient;

  return { prisma, queries };
}

function candidate(input: {
  chunkId: string;
  chunkIndex: number;
  documentIndexId?: string | null;
  sectionHeadingPath?: string[];
  fallbackText?: string;
}): EvidenceSectionCandidate {
  return {
    chunkId: input.chunkId,
    documentIndexId: input.documentIndexId === undefined ? "dix_1" : input.documentIndexId,
    chunkIndex: input.chunkIndex,
    sectionHeadingPath: input.sectionHeadingPath ?? ["后厨卫生规范"],
    fallbackText: input.fallbackText ?? `chunk ${input.chunkIndex}`
  };
}

describe("evidence section expansion", () => {
  it("expands a matched chunk into its whole heading section in reading order", async () => {
    const { prisma } = fakePrisma({
      dix_1: [
        { chunkIndex: 0, chunkText: "前言", sectionHeadingPath: ["前言"] },
        { chunkIndex: 1, chunkText: "第一条 地面清洁", sectionHeadingPath: ["后厨卫生规范"] },
        { chunkIndex: 2, chunkText: "第二条 操作台消毒", sectionHeadingPath: ["后厨卫生规范"] },
        { chunkIndex: 3, chunkText: "第三条 垃圾清运", sectionHeadingPath: ["后厨卫生规范"] },
        { chunkIndex: 4, chunkText: "附则", sectionHeadingPath: ["附则"] }
      ]
    });
    const expander = createPrismaEvidenceSectionExpander({
      prisma,
      maxSectionChars: 6_000,
      maxSectionChunks: 6
    });

    const expansions = await expander.expand([candidate({ chunkId: "chk_2", chunkIndex: 2 })]);

    expect(expansions.get("chk_2")).toEqual({
      sectionText: "第一条 地面清洁\n第二条 操作台消毒\n第三条 垃圾清运",
      sectionTruncated: false
    });
  });

  it("does not cross a heading boundary", async () => {
    const { prisma } = fakePrisma({
      dix_1: [
        {
          chunkIndex: 0,
          chunkText: "前一条 地面清洁",
          sectionHeadingPath: ["后厨卫生规范", "地面"]
        },
        {
          chunkIndex: 1,
          chunkText: "后一条 操作台消毒",
          sectionHeadingPath: ["后厨卫生规范", "操作台"]
        }
      ]
    });
    const expander = createPrismaEvidenceSectionExpander({
      prisma,
      maxSectionChars: 6_000,
      maxSectionChunks: 6
    });

    const expansions = await expander.expand([
      candidate({ chunkId: "chk_1", chunkIndex: 1, sectionHeadingPath: ["后厨卫生规范", "操作台"] })
    ]);

    expect(expansions.get("chk_1")).toEqual({
      sectionText: "后一条 操作台消毒",
      sectionTruncated: false
    });
  });

  it("caps the section at the configured chunk and character limits", async () => {
    const { prisma } = fakePrisma({
      dix_1: Array.from({ length: 9 }, (_, index) => ({
        chunkIndex: index,
        chunkText: `条款 ${index} ${"内".repeat(600)}`,
        sectionHeadingPath: ["后厨卫生规范"]
      }))
    });
    const expander = createPrismaEvidenceSectionExpander({
      prisma,
      maxSectionChars: 1_500,
      maxSectionChunks: 3
    });

    const expansions = await expander.expand([candidate({ chunkId: "chk_4", chunkIndex: 4 })]);
    const expansion = expansions.get("chk_4");

    expect(expansion?.sectionTruncated).toBe(true);
    expect(expansion?.sectionText).toContain("条款 4");
    expect((expansion?.sectionText.match(/条款/g) ?? []).length).toBeLessThanOrEqual(3);
    expect(expansion?.sectionText.length).toBeLessThanOrEqual(1_500 + 700);
  });

  it("falls back to immediate neighbours for documents without headings", async () => {
    const { prisma } = fakePrisma({
      dix_1: [
        { chunkIndex: 0, chunkText: "上一段", sectionHeadingPath: [] },
        { chunkIndex: 1, chunkText: "命中段", sectionHeadingPath: [] },
        { chunkIndex: 2, chunkText: "下一段", sectionHeadingPath: [] },
        { chunkIndex: 3, chunkText: "更远的段落", sectionHeadingPath: [] }
      ]
    });
    const expander = createPrismaEvidenceSectionExpander({
      prisma,
      maxSectionChars: 6_000,
      maxSectionChunks: 6
    });

    const expansions = await expander.expand([
      candidate({ chunkId: "chk_1", chunkIndex: 1, sectionHeadingPath: [] })
    ]);

    expect(expansions.get("chk_1")).toEqual({
      sectionText: "上一段\n命中段\n下一段",
      sectionTruncated: false
    });
  });

  it("falls back to the matched chunk text when no index row is addressable", async () => {
    const { prisma, queries } = fakePrisma({});
    const expander = createPrismaEvidenceSectionExpander({
      prisma,
      maxSectionChars: 6_000,
      maxSectionChunks: 6
    });

    const expansions = await expander.expand([
      candidate({
        chunkId: "chk_no_index",
        chunkIndex: 3,
        documentIndexId: null,
        fallbackText: "回退文本"
      })
    ]);

    expect(queries).toHaveLength(0);
    expect(expansions.get("chk_no_index")).toEqual({
      sectionText: "回退文本",
      sectionTruncated: false
    });
  });

  it("queries each document index once for the whole page", async () => {
    const { prisma, queries } = fakePrisma({
      dix_1: [
        { chunkIndex: 3, chunkText: "a", sectionHeadingPath: ["S"] },
        { chunkIndex: 4, chunkText: "b", sectionHeadingPath: ["S"] }
      ],
      dix_2: [{ chunkIndex: 1, chunkText: "c", sectionHeadingPath: ["T"] }]
    });
    const expander = createPrismaEvidenceSectionExpander({
      prisma,
      maxSectionChars: 6_000,
      maxSectionChunks: 6
    });

    await expander.expand([
      candidate({ chunkId: "chk_a", chunkIndex: 3 }),
      candidate({ chunkId: "chk_b", chunkIndex: 4 }),
      candidate({ chunkId: "chk_c", chunkIndex: 1, documentIndexId: "dix_2" })
    ]);

    expect(queries).toHaveLength(2);
    expect(queries[0]?.ranges).toEqual([{ chunkIndex: { gte: -3, lte: 10 } }]);
  });

  it("normalizes heading paths into stable section keys", () => {
    expect(sectionKeyFromHeadingPath(["后厨卫生规范", "地面清洁"])).toBe(
      "后厨卫生规范\u001f地面清洁"
    );
    expect(sectionKeyFromHeadingPath([])).toBe("");
  });
});
