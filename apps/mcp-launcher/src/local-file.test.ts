import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { launcherUploadFileInputSchema } from "@enterprise-hub/mcp-contract";
import {
  LOCAL_UPLOAD_ERROR_CODES,
  readLocalUploadFile,
  type LauncherPathUploadFile
} from "./local-file.js";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "eh-launcher-local-file-"));
  tempRoots.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("launcher local file reads", () => {
  it("reads a regular file with exact bytes and canonical base64", async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, "dishes.csv");
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x7b, 0x22, 0x61, 0x22, 0x7d]);
    await writeFile(filePath, bytes);

    const result = await readLocalUploadFile(pathUpload(filePath));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.equals(bytes)).toBe(true);
    expect(
      launcherUploadFileInputSchema.safeParse({
        name: "dishes.csv",
        mediaType: "text/csv",
        encoding: "base64",
        contentBase64: result.body.toString("base64")
      }).success
    ).toBe(true);
  });

  it("returns NOT_FOUND for a missing file", async () => {
    const dir = await tempDir();
    const result = await readLocalUploadFile(pathUpload(path.join(dir, "missing.csv")));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(errorCode(result.result)).toBe(LOCAL_UPLOAD_ERROR_CODES.NOT_FOUND);
  });

  it("returns INVALID for a directory path", async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, "folder"));
    const result = await readLocalUploadFile(pathUpload(path.join(dir, "folder")));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(errorCode(result.result)).toBe(LOCAL_UPLOAD_ERROR_CODES.INVALID);
  });

  it("returns INVALID for a relative path", async () => {
    const result = await readLocalUploadFile(pathUpload("dishes.csv"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(errorCode(result.result)).toBe(LOCAL_UPLOAD_ERROR_CODES.INVALID);
  });

  it("returns TOO_LARGE when the file exceeds the upload limit", async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, "big.csv");
    await writeFile(filePath, Buffer.from("12345678"));

    const result = await readLocalUploadFile(pathUpload(filePath), 4);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(errorCode(result.result)).toBe(LOCAL_UPLOAD_ERROR_CODES.TOO_LARGE);
    expect(errorDetails(result.result)).toMatchObject({
      maxUploadBytes: 4,
      actualBytes: 8
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    "returns PERMISSION_DENIED for an unreadable file",
    async () => {
      const dir = await tempDir();
      const filePath = path.join(dir, "secret.csv");
      await writeFile(filePath, "secret");
      await chmod(filePath, 0o000);

      const result = await readLocalUploadFile(pathUpload(filePath));

      await chmod(filePath, 0o600);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(errorCode(result.result)).toBe(LOCAL_UPLOAD_ERROR_CODES.PERMISSION_DENIED);
    }
  );
});

function pathUpload(filePath: string): LauncherPathUploadFile {
  return {
    name: "dishes.csv",
    mediaType: "text/csv",
    encoding: "path",
    filePath
  };
}

function errorBody(result: { content: Array<{ text: string }> }): {
  error: { code: string; details?: unknown };
} {
  return JSON.parse(result.content[0]?.text ?? "null") as {
    error: { code: string; details?: unknown };
  };
}

function errorCode(result: { content: Array<{ text: string }> }): string {
  return errorBody(result).error.code;
}

function errorDetails(result: { content: Array<{ text: string }> }): unknown {
  return errorBody(result).error.details;
}
