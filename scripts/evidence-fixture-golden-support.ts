import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface EvidenceFixtureManifestV1 {
  schemaVersion: 1;
  documents: EvidenceFixtureDocument[];
  cases: EvidenceFixtureCase[];
}

export interface EvidenceFixtureDocument {
  fixtureId: string;
  path: string;
  title: string;
  sha256: string;
  confidentialityLevel: 0;
}

export interface EvidenceFixtureCase {
  caseId: string;
  query: string;
  relevantFixtureIds: string[];
  unacceptableFixtureIds: string[];
  expectNoAnswer: boolean;
  notes: string;
}

export interface EvidenceCaseObservation {
  caseId: string;
  runLabel: string;
  gitSha: string;
  retrieval: Record<string, unknown> & {
    retrievalConfigVersion: string;
  };
  results: EvidenceObservedChunk[];
}

export interface EvidenceObservedChunk {
  documentId: string;
  fixtureId: string;
  chunkId: string;
  hybridScore: number | null;
  rerankScore: number | null;
  downloadUrl: string | null;
}

export interface EvidenceFixtureEvaluationReport {
  runLabel: string;
  gitSha: string;
  retrieval: EvidenceCaseObservation["retrieval"];
  cases: Array<{
    caseId: string;
    query: string;
    expectNoAnswer: boolean;
    relevantFixtureIds: string[];
    unacceptableFixtureIds: string[];
    orderedDocuments: Array<{
      documentId: string;
      fixtureId: string;
      chunkIds: string[];
      hybridScore: number | null;
      rerankScore: number | null;
      downloadUrl: string | null;
    }>;
  }>;
  metrics: {
    hitRateAt5: number;
    recallAt10: number;
    mrrAt10: number;
    unacceptableReturnCount: number;
    noAnswerFalsePositiveRate: number;
    downloadLinkCoverage: number;
  };
}

export async function loadEvidenceFixtureManifest(
  manifestPath: string
): Promise<EvidenceFixtureManifestV1> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read evidence fixture manifest ${manifestPath}: ${message(error)}`);
  }

  const manifest = validateManifestShape(parsed);
  const manifestDirectory = path.dirname(path.resolve(manifestPath));
  const fixtureIds = new Set<string>();

  for (const document of manifest.documents) {
    if (fixtureIds.has(document.fixtureId)) {
      throw new Error(`Evidence fixture manifest has duplicate fixtureId: ${document.fixtureId}.`);
    }
    fixtureIds.add(document.fixtureId);

    const fixturePath = path.resolve(manifestDirectory, document.path);
    const relativePath = path.relative(manifestDirectory, fixturePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Evidence fixture path escapes the manifest directory: ${document.path}.`);
    }

    let content: Buffer;
    try {
      content = await readFile(fixturePath);
    } catch (error) {
      throw new Error(
        `Evidence fixture manifest references a missing fixture file: ${document.path} (${message(error)}).`
      );
    }

    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== document.sha256) {
      throw new Error(
        `Evidence fixture checksum mismatch for ${document.fixtureId}: expected ${document.sha256}, got ${digest}.`
      );
    }
  }

  const caseIds = new Set<string>();
  for (const fixtureCase of manifest.cases) {
    if (caseIds.has(fixtureCase.caseId)) {
      throw new Error(`Evidence fixture manifest has duplicate caseId: ${fixtureCase.caseId}.`);
    }
    caseIds.add(fixtureCase.caseId);

    if (fixtureCase.expectNoAnswer && fixtureCase.relevantFixtureIds.length > 0) {
      throw new Error(
        `Evidence fixture case ${fixtureCase.caseId} cannot be answerable and expectNoAnswer.`
      );
    }

    const unknownRelevant = fixtureCase.relevantFixtureIds.filter((id) => !fixtureIds.has(id));
    if (unknownRelevant.length > 0) {
      throw new Error(
        `Evidence fixture case ${fixtureCase.caseId} has unknown relevant fixture IDs: ${unknownRelevant.join(", ")}.`
      );
    }

    const unknownUnacceptable = fixtureCase.unacceptableFixtureIds.filter(
      (id) => !fixtureIds.has(id)
    );
    if (unknownUnacceptable.length > 0) {
      throw new Error(
        `Evidence fixture case ${fixtureCase.caseId} has unknown unacceptable fixture IDs: ${unknownUnacceptable.join(", ")}.`
      );
    }

    const unacceptable = new Set(fixtureCase.unacceptableFixtureIds);
    const overlap = fixtureCase.relevantFixtureIds.filter((id) => unacceptable.has(id));
    if (overlap.length > 0) {
      throw new Error(
        `Evidence fixture case ${fixtureCase.caseId} marks fixtures both relevant and unacceptable: ${overlap.join(", ")}.`
      );
    }
  }

  return manifest;
}

export function evaluateEvidenceFixtureCases(
  manifest: EvidenceFixtureManifestV1,
  observations: readonly EvidenceCaseObservation[]
): EvidenceFixtureEvaluationReport {
  const observationByCaseId = new Map<string, EvidenceCaseObservation>();
  for (const observation of observations) {
    if (observationByCaseId.has(observation.caseId)) {
      throw new Error(`Duplicate evidence observation for case ${observation.caseId}.`);
    }
    observationByCaseId.set(observation.caseId, observation);
  }

  const firstObservation = observations[0];
  if (!firstObservation) {
    throw new Error("At least one evidence case observation is required.");
  }

  let hitCount = 0;
  let recallSum = 0;
  let reciprocalRankSum = 0;
  let answerableCount = 0;
  let unacceptableReturnCount = 0;
  let noAnswerCount = 0;
  let noAnswerFalsePositiveCount = 0;
  const returnedDocuments = new Map<string, boolean>();

  const cases = manifest.cases.map((fixtureCase) => {
    const observation = observationByCaseId.get(fixtureCase.caseId);
    if (!observation) {
      throw new Error(`Missing evidence observation for case ${fixtureCase.caseId}.`);
    }
    if (
      observation.runLabel !== firstObservation.runLabel ||
      observation.gitSha !== firstObservation.gitSha ||
      observation.retrieval.retrievalConfigVersion !==
        firstObservation.retrieval.retrievalConfigVersion
    ) {
      throw new Error("Evidence observations must belong to one run and retrieval configuration.");
    }

    const orderedDocuments = dedupeObservedDocuments(observation.results);
    for (const document of orderedDocuments) {
      returnedDocuments.set(
        document.documentId,
        (returnedDocuments.get(document.documentId) ?? false) || document.downloadUrl !== null
      );
    }

    const relevant = new Set(fixtureCase.relevantFixtureIds);
    const unacceptable = new Set(fixtureCase.unacceptableFixtureIds);
    unacceptableReturnCount += new Set(
      orderedDocuments
        .map((document) => document.fixtureId)
        .filter((fixtureId) => unacceptable.has(fixtureId))
    ).size;

    if (fixtureCase.expectNoAnswer) {
      noAnswerCount += 1;
      if (orderedDocuments.length > 0) noAnswerFalsePositiveCount += 1;
    } else {
      answerableCount += 1;
      const topFive = orderedDocuments.slice(0, 5);
      if (topFive.some((document) => relevant.has(document.fixtureId))) hitCount += 1;

      const topTenRelevant = new Set(
        orderedDocuments
          .slice(0, 10)
          .map((document) => document.fixtureId)
          .filter((fixtureId) => relevant.has(fixtureId))
      );
      recallSum += relevant.size === 0 ? 0 : topTenRelevant.size / relevant.size;

      const firstRelevantIndex = orderedDocuments
        .slice(0, 10)
        .findIndex((document) => relevant.has(document.fixtureId));
      reciprocalRankSum += firstRelevantIndex < 0 ? 0 : 1 / (firstRelevantIndex + 1);
    }

    return {
      caseId: fixtureCase.caseId,
      query: fixtureCase.query,
      expectNoAnswer: fixtureCase.expectNoAnswer,
      relevantFixtureIds: [...fixtureCase.relevantFixtureIds],
      unacceptableFixtureIds: [...fixtureCase.unacceptableFixtureIds],
      orderedDocuments
    };
  });

  const documentsWithDownload = [...returnedDocuments.values()].filter(Boolean).length;
  return {
    runLabel: firstObservation.runLabel,
    gitSha: firstObservation.gitSha,
    retrieval: { ...firstObservation.retrieval },
    cases,
    metrics: {
      hitRateAt5: ratio(hitCount, answerableCount),
      recallAt10: ratio(recallSum, answerableCount),
      mrrAt10: ratio(reciprocalRankSum, answerableCount),
      unacceptableReturnCount,
      noAnswerFalsePositiveRate: ratio(noAnswerFalsePositiveCount, noAnswerCount),
      downloadLinkCoverage:
        returnedDocuments.size === 0 ? 1 : round(documentsWithDownload / returnedDocuments.size)
    }
  };
}

function dedupeObservedDocuments(results: readonly EvidenceObservedChunk[]) {
  const documents = new Map<
    string,
    {
      documentId: string;
      fixtureId: string;
      chunkIds: string[];
      hybridScore: number | null;
      rerankScore: number | null;
      downloadUrl: string | null;
    }
  >();

  for (const result of results) {
    const existing = documents.get(result.documentId);
    if (existing) {
      existing.chunkIds.push(result.chunkId);
      existing.downloadUrl ??= result.downloadUrl;
      continue;
    }
    documents.set(result.documentId, {
      documentId: result.documentId,
      fixtureId: result.fixtureId,
      chunkIds: [result.chunkId],
      hybridScore: result.hybridScore,
      rerankScore: result.rerankScore,
      downloadUrl: result.downloadUrl
    });
  }

  return [...documents.values()];
}

function validateManifestShape(value: unknown): EvidenceFixtureManifestV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Evidence fixture manifest schemaVersion must be 1.");
  }
  if (!Array.isArray(value.documents) || !Array.isArray(value.cases)) {
    throw new Error("Evidence fixture manifest documents and cases must be arrays.");
  }

  const documents = value.documents.map((candidate, index) => {
    if (
      !isRecord(candidate) ||
      !nonEmptyString(candidate.fixtureId) ||
      !nonEmptyString(candidate.path) ||
      !nonEmptyString(candidate.title) ||
      typeof candidate.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(candidate.sha256) ||
      candidate.confidentialityLevel !== 0
    ) {
      throw new Error(`Evidence fixture manifest document ${index} is invalid.`);
    }
    return candidate as unknown as EvidenceFixtureDocument;
  });

  const cases = value.cases.map((candidate, index) => {
    if (
      !isRecord(candidate) ||
      !nonEmptyString(candidate.caseId) ||
      !nonEmptyString(candidate.query) ||
      !stringArray(candidate.relevantFixtureIds) ||
      !stringArray(candidate.unacceptableFixtureIds) ||
      typeof candidate.expectNoAnswer !== "boolean" ||
      typeof candidate.notes !== "string"
    ) {
      throw new Error(`Evidence fixture manifest case ${index} is invalid.`);
    }
    return candidate as unknown as EvidenceFixtureCase;
  });

  return { schemaVersion: 1, documents, cases };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every(nonEmptyString) && new Set(value).size === value.length
  );
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? 0 : round(numerator / denominator);
}

function round(value: number) {
  return Number(value.toFixed(4));
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
