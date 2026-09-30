import { open, stat } from "node:fs/promises";
import { dirname } from "node:path";
export interface PdfImageProof {
  image: string;
  id: string;
  pdfReader?: boolean;
  parserFingerprint?: string;
  schemaVersion?: number;
}
export interface PdfReleaseBundle {
  api: PdfImageProof;
  worker: PdfImageProof;
  releaseOps: PdfImageProof;
  parser: PdfImageProof | null;
  pdfProcessing: boolean;
  uploads: boolean;
}
export interface PdfRuntimeState {
  schemaVersion: 1;
  floorEstablished: boolean;
  current: PdfReleaseBundle;
  rollback: PdfReleaseBundle;
}
const readers = ["api", "worker", "releaseOps"] as const;
function compatible(bundle: PdfReleaseBundle): boolean {
  return readers.every((role) => bundle[role].pdfReader === true);
}
function validateBundle(value: PdfReleaseBundle): void {
  if (!value || typeof value.pdfProcessing !== "boolean" || typeof value.uploads !== "boolean")
    throw new Error("Invalid PDF release bundle.");
  for (const image of [
    ...readers.map((role) => value[role]),
    ...(value.parser ? [value.parser] : [])
  ]) {
    if (
      !image ||
      !/^[A-Za-z0-9._:/@-]{1,512}$/u.test(image.image) ||
      !/^sha256:[a-f0-9]{64}$/u.test(image.id)
    )
      throw new Error("Invalid verified image identity.");
  }
  if ((value.pdfProcessing || value.uploads) && (!value.parser || !compatible(value)))
    throw new Error("PDF requires compatible readers and a parser image.");
  if (
    value.pdfProcessing &&
    (!/^[a-f0-9]{64}$/u.test(value.parser?.parserFingerprint ?? "") ||
      value.parser?.schemaVersion !== 1)
  )
    throw new Error("Invalid parser protocol identity.");
  if (value.uploads && !value.pdfProcessing) throw new Error("PDF uploads require a PDF worker.");
}
export function parsePdfRuntimeState(value: unknown): PdfRuntimeState {
  const state = value as PdfRuntimeState;
  if (!state || state.schemaVersion !== 1 || typeof state.floorEstablished !== "boolean")
    throw new Error("PDF runtime state missing or invalid.");
  validateBundle(state.current);
  validateBundle(state.rollback);
  if (state.floorEstablished && (!compatible(state.current) || !compatible(state.rollback)))
    throw new Error("PDF rollback requires compatible readers.");
  return state;
}
export function transitionPdfRuntimeState(
  state: PdfRuntimeState | null,
  current: PdfReleaseBundle,
  rollback: PdfReleaseBundle
): PdfRuntimeState {
  validateBundle(current);
  validateBundle(rollback);
  if (state) parsePdfRuntimeState(state);
  // Bootstrap only before admission existed, from verified PDF-unaware API AND worker.
  if (
    !state &&
    (rollback.api.pdfReader !== false ||
      rollback.worker.pdfReader !== false ||
      rollback.uploads ||
      current.uploads)
  )
    throw new Error("PDF runtime state missing; recovery required.");
  const floorEstablished = state?.floorEstablished === true || current.uploads;
  if (floorEstablished && (!compatible(current) || !compatible(rollback)))
    throw new Error("PDF rollback requires compatible readers.");
  return { schemaVersion: 1, floorEstablished, current, rollback };
}
export function verifyPdfRuntimeState(value: unknown, env: NodeJS.ProcessEnv): boolean {
  try {
    const state = parsePdfRuntimeState(value);
    if (!state.floorEstablished || !state.current.uploads || !state.current.pdfProcessing)
      return false;
    return (
      env["SMEDC_API_IMAGE"] === state.current.api.image &&
      env["SMEDC_WORKER_IMAGE"] === state.current.worker.image &&
      env["SMEDC_RELEASE_OPS_IMAGE"] === state.current.releaseOps.image &&
      env["SMEDC_PDF_PARSER_IMAGE"] === state.current.parser?.image
    );
  } catch {
    return false;
  }
}
export function createDeploymentPdfRollbackFloorVerifier(
  env: NodeJS.ProcessEnv
): () => Promise<boolean> {
  return async () => {
    try {
      const path = env["SMEDC_PDF_RUNTIME_STATE_PATH"];
      if (!path) return false;
      const directory = await stat(dirname(path));
      const handle = await open(path, "r");
      try {
        const info = await handle.stat();
        if (
          directory.uid !== 0 ||
          (directory.mode & 0o022) !== 0 ||
          info.uid !== 0 ||
          (info.mode & 0o022) !== 0 ||
          !info.isFile() ||
          info.size > 16_384
        )
          return false;
        return verifyPdfRuntimeState(JSON.parse(await handle.readFile("utf8")), env);
      } finally {
        await handle.close();
      }
    } catch {
      return false;
    }
  };
}
