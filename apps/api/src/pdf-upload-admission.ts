/** Task6 supplies a verifier backed by deployment-verified current/rollback image identities.
 * An environment boolean alone is never evidence of a compatible rollback floor. */
export type PdfRollbackFloorVerifier = () => Promise<boolean>;
export type PdfUploadAdmissionResult =
  | { allowed: true }
  | {
      allowed: false;
      code: "PDF_UPLOAD_DISABLED" | "PDF_ROLLBACK_FLOOR_UNVERIFIED" | "PDF_SERVICE_UNAVAILABLE";
    };
export type PdfUploadAdmission = () => Promise<PdfUploadAdmissionResult>;

export function createPdfUploadAdmission(input: {
  environment: NodeJS.ProcessEnv;
  verifyRollbackFloor?: PdfRollbackFloorVerifier;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}): PdfUploadAdmission {
  let cached: { ready: boolean; expiresAt: number } | null = null;
  let pending: Promise<boolean> | null = null;
  const now = input.now ?? Date.now;
  return async () => {
    if (input.environment["SMEDC_PDF_UPLOAD_ENABLED"] !== "true")
      return { allowed: false, code: "PDF_UPLOAD_DISABLED" };
    try {
      if (!(await input.verifyRollbackFloor?.()))
        return { allowed: false, code: "PDF_ROLLBACK_FLOOR_UNVERIFIED" };
    } catch {
      return { allowed: false, code: "PDF_ROLLBACK_FLOOR_UNVERIFIED" };
    }
    if (!cached || cached.expiresAt <= now()) {
      pending ??= checkParserReadiness(input)
        .then((ready) => {
          cached = { ready, expiresAt: now() + 5000 };
          return ready;
        })
        .finally(() => {
          pending = null;
        });
      await pending;
    }
    return cached?.ready ? { allowed: true } : { allowed: false, code: "PDF_SERVICE_UNAVAILABLE" };
  };
}

async function checkParserReadiness(input: {
  environment: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<boolean> {
  try {
    const url = new URL(input.environment["SMEDC_PDF_SERVICE_URL"] ?? "");
    const token = input.environment["SMEDC_PDF_SERVICE_TOKEN"] ?? "";
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      Buffer.byteLength(token) < 32 ||
      /[\r\n]/u.test(token)
    )
      return false;
    const signal = AbortSignal.timeout(input.timeoutMs ?? 2000);
    const response = await (input.fetch ?? fetch)(`${url.origin}/v1/ready`, {
      method: "GET",
      redirect: "error",
      headers: { authorization: `Bearer ${token}` },
      signal
    });
    const length = response.headers.get("content-length");
    if (
      response.status !== 200 ||
      (length !== null && (!/^\d+$/u.test(length) || Number(length) > 1024))
    ) {
      await response.body?.cancel();
      return false;
    }
    const reader = response.body?.getReader();
    if (!reader) return false;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 1024) {
          await reader.cancel();
          return false;
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return (
      typeof value === "object" &&
      value !== null &&
      "status" in value &&
      value.status === "ready" &&
      "schemaVersion" in value &&
      value.schemaVersion === 1 &&
      "parserFingerprint" in value &&
      typeof value.parserFingerprint === "string" &&
      /^[a-f0-9]{64}$/u.test(value.parserFingerprint)
    );
  } catch {
    return false;
  }
}
