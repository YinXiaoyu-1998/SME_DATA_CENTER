import path from "node:path";
import type { PutObjectInput } from "./storage-adapter.js";

export function createOriginalObjectKey(
  input: Pick<PutObjectInput, "orgId" | "documentId" | "fileName">
): string {
  const orgId = sanitizeStorageSegment(input.orgId, "orgId");
  const documentId = sanitizeStorageSegment(input.documentId, "documentId");
  const safeFileName = sanitizeFileName(input.fileName);

  return `org/${orgId}/documents/${documentId}/original/${safeFileName}`;
}

export function createPartitionStagingObjectKey(input: { orgId: string; jobId: string }): string {
  return `structured-import-staging/${sanitizeStorageSegment(input.orgId, "orgId")}/${sanitizeStorageSegment(input.jobId, "jobId")}/source`;
}

export function createPartitionObjectKey(input: {
  orgId: string;
  jobId: string;
  partitionId: string;
}): string {
  return `structured-partitions/${sanitizeStorageSegment(input.orgId, "orgId")}/${sanitizeStorageSegment(input.jobId, "jobId")}/${sanitizeStorageSegment(input.partitionId, "partitionId")}.csv`;
}

export function assertSafeObjectKey(key: string): void {
  if (key.includes("\\") || path.isAbsolute(key)) {
    throw new Error("Storage object key must be relative.");
  }

  const segments = key.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Storage object key contains unsafe path segments.");
  }
}

function sanitizeStorageSegment(value: string, fieldName: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${fieldName} contains unsafe storage characters.`);
  }

  return value;
}

function sanitizeFileName(fileName: string): string {
  const baseName = path.basename(fileName.replaceAll("\\", "/"));
  const safeName = baseName
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "");

  return safeName || "file";
}

export function assertOrgInventoryPrefix(prefix: string): void {
  if (!/^org\/[A-Za-z0-9_-]+\/$/.test(prefix)) {
    throw new Error("Object inventory requires one exact org directory prefix.");
  }
}
