import { readFile, stat } from "node:fs/promises";
import { MCP_UPLOAD_MAX_BYTES, errorToolResult, localFilePath } from "@smedc/mcp-contract";
import type { LauncherToolResult } from "./launcher.js";

export const LOCAL_UPLOAD_ERROR_CODES = {
  NOT_FOUND: "MCP_LOCAL_FILE_NOT_FOUND",
  PERMISSION_DENIED: "MCP_LOCAL_FILE_PERMISSION_DENIED",
  INVALID: "MCP_LOCAL_FILE_INVALID",
  TOO_LARGE: "MCP_LOCAL_FILE_TOO_LARGE",
  READ_FAILED: "MCP_LOCAL_FILE_READ_FAILED"
} as const;

export interface LauncherPathUploadFile {
  name: string;
  mediaType: string;
  encoding: "path";
  filePath: string;
}

export type LocalFileReadResult =
  { ok: true; body: Buffer } | { ok: false; result: LauncherToolResult };

export async function readLocalUploadFile(
  file: LauncherPathUploadFile,
  maxBytes: number = MCP_UPLOAD_MAX_BYTES
): Promise<LocalFileReadResult> {
  const pathCheck = localFilePath.safeParse(file.filePath);

  if (!pathCheck.success) {
    return localFileError(
      LOCAL_UPLOAD_ERROR_CODES.INVALID,
      "Local upload file path must be absolute."
    );
  }

  let stats;
  try {
    stats = await stat(file.filePath);
  } catch (error) {
    return mapLocalReadError(error);
  }

  if (!stats.isFile()) {
    return localFileError(
      LOCAL_UPLOAD_ERROR_CODES.INVALID,
      "Local upload path is not a regular file."
    );
  }

  if (stats.size > maxBytes) {
    return localFileError(LOCAL_UPLOAD_ERROR_CODES.TOO_LARGE, "Local upload file is too large.", {
      maxUploadBytes: maxBytes,
      actualBytes: stats.size
    });
  }

  try {
    const body = await readFile(file.filePath);
    return { ok: true, body };
  } catch (error) {
    return mapLocalReadError(error);
  }
}

function mapLocalReadError(error: unknown): { ok: false; result: LauncherToolResult } {
  const code = isNodeError(error) ? error.code : undefined;

  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
      return localFileError(LOCAL_UPLOAD_ERROR_CODES.NOT_FOUND, "Local upload file was not found.");
    case "EACCES":
    case "EPERM":
      return localFileError(
        LOCAL_UPLOAD_ERROR_CODES.PERMISSION_DENIED,
        "Insufficient permission to read the local upload file."
      );
    case "EISDIR":
      return localFileError(
        LOCAL_UPLOAD_ERROR_CODES.INVALID,
        "Local upload path is a directory, not a file."
      );
    default:
      return localFileError(
        LOCAL_UPLOAD_ERROR_CODES.READ_FAILED,
        "Failed to read the local upload file."
      );
  }
}

function localFileError(
  code: string,
  message: string,
  details?: unknown
): { ok: false; result: LauncherToolResult } {
  return {
    ok: false,
    result: errorToolResult(code, message, details, { retryable: false })
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
