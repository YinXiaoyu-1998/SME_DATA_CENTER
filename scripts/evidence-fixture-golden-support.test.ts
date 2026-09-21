import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateEvidenceFixtureCases,
  loadEvidenceFixtureManifest,
  type EvidenceCaseObservation,
  type EvidenceFixtureManifestV1
} from "./evidence-fixture-golden-support.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("evidence fixture manifest", () => {
  it("loads a valid manifest and verifies fixture bytes", async () => {
    const { manifestPath } = await writeManifest(baseManifest());

    await expect(loadEvidenceFixtureManifest(manifestPath)).resolves.toMatchObject({
      schemaVersion: 1,
      documents: [{ fixtureId: "relevant-doc" }]
    });
  });

  it.each([
    {
      name: "duplicate fixture IDs",
      mutate: (manifest: EvidenceFixtureManifestV1) => {
        manifest.documents.push({ ...manifest.documents[0]! });
      },
      message: "duplicate fixtureId"
    },
    {
      name: "answerable no-answer cases",
      mutate: (manifest: EvidenceFixtureManifestV1) => {
        manifest.cases[0]!.expectNoAnswer = true;
      },
      message: "expectNoAnswer"
    },
    {
      name: "unknown relevant fixture IDs",
      mutate: (manifest: EvidenceFixtureManifestV1) => {
        manifest.cases[0]!.relevantFixtureIds = ["unknown"];
      },
      message: "unknown relevant"
    },
    {
      name: "unknown unacceptable fixture IDs",
      mutate: (manifest: EvidenceFixtureManifestV1) => {
        manifest.cases[0]!.unacceptableFixtureIds = ["unknown"];
      },
      message: "unknown unacceptable"
    },
    {
      name: "overlapping judgments",
      mutate: (manifest: EvidenceFixtureManifestV1) => {
        manifest.cases[0]!.unacceptableFixtureIds = ["relevant-doc"];
      },
      message: "both relevant and unacceptable"
    }
  ])("rejects $name", async ({ mutate, message }) => {
    const manifest = baseManifest();
    mutate(manifest);
    const { manifestPath } = await writeManifest(manifest);

    await expect(loadEvidenceFixtureManifest(manifestPath)).rejects.toThrow(message);
  });

  it("rejects a manifest whose fixture file is missing", async () => {
    const manifest = baseManifest();
    manifest.documents[0]!.path = "missing.docx";
    const { manifestPath } = await writeManifest(manifest);

    await expect(loadEvidenceFixtureManifest(manifestPath)).rejects.toThrow("missing fixture file");
  });
});

describe("evidence fixture evaluation", () => {
  it("dedupes returned chunks by document for ranking and unacceptable counts", () => {
    const manifest = baseManifest();
    manifest.documents.push({
      fixtureId: "bad-doc",
      path: "bad.docx",
      title: "Bad",
      sha256: "b".repeat(64),
      confidentialityLevel: 0
    });
    manifest.cases[0]!.unacceptableFixtureIds = ["bad-doc"];
    const observation = baseObservation({
      results: [
        result("actual-bad", "bad-doc", "bad-1", null),
        result("actual-bad", "bad-doc", "bad-2", null),
        result("actual-good", "relevant-doc", "good-1", "https://download.test/good")
      ]
    });

    const report = evaluateEvidenceFixtureCases(manifest, [observation]);

    expect(report.cases[0]?.orderedDocuments.map((document) => document.fixtureId)).toEqual([
      "bad-doc",
      "relevant-doc"
    ]);
    expect(report.metrics).toMatchObject({
      hitRateAt5: 1,
      recallAt10: 1,
      mrrAt10: 0.5,
      unacceptableReturnCount: 1,
      noAnswerFalsePositiveRate: 0,
      downloadLinkCoverage: 0.5
    });
  });

  it("scores a zero-result no-answer case without division errors", () => {
    const manifest = baseManifest();
    manifest.cases = [
      {
        caseId: "no-answer",
        query: "unknown",
        relevantFixtureIds: [],
        unacceptableFixtureIds: ["relevant-doc"],
        expectNoAnswer: true,
        notes: "No fixture answers this."
      }
    ];

    const report = evaluateEvidenceFixtureCases(manifest, [
      baseObservation({ caseId: "no-answer", results: [] })
    ]);

    expect(report.metrics).toEqual({
      hitRateAt5: 0,
      recallAt10: 0,
      mrrAt10: 0,
      unacceptableReturnCount: 0,
      noAnswerFalsePositiveRate: 0,
      downloadLinkCoverage: 1
    });
  });
});

function baseManifest(): EvidenceFixtureManifestV1 {
  return {
    schemaVersion: 1,
    documents: [
      {
        fixtureId: "relevant-doc",
        path: "fixture.docx",
        title: "Relevant",
        sha256: sha256("fixture"),
        confidentialityLevel: 0
      }
    ],
    cases: [
      {
        caseId: "answerable",
        query: "question",
        relevantFixtureIds: ["relevant-doc"],
        unacceptableFixtureIds: [],
        expectNoAnswer: false,
        notes: "Fixture answers this."
      }
    ]
  };
}

async function writeManifest(manifest: EvidenceFixtureManifestV1) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "smedc-evidence-manifest-"));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, "fixture.docx"), "fixture", "utf8");
  const manifestPath = path.join(directory, "golden.json");
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  return { manifestPath };
}

function baseObservation(
  overrides: Partial<EvidenceCaseObservation> = {}
): EvidenceCaseObservation {
  return {
    caseId: "answerable",
    runLabel: "test-run",
    gitSha: "abc1234",
    retrieval: {
      retrievalConfigVersion: "phase3.retrieval.v1",
      rerankStatus: "enabled"
    },
    results: [result("actual-good", "relevant-doc", "chunk-1", null)],
    ...overrides
  };
}

function result(
  documentId: string,
  fixtureId: string,
  chunkId: string,
  downloadUrl: string | null
) {
  return {
    documentId,
    fixtureId,
    chunkId,
    hybridScore: 0.5,
    rerankScore: 0.7,
    downloadUrl
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
