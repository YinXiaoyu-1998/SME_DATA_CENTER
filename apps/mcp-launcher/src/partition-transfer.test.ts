import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadPartitionDataset, uploadPartitionDataset } from "./partition-transfer.js";

describe("launcher partition transfer", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("streams a path upload through bounded multipart URLs and returns only the job", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "launcher-partition-"));
    const source = path.join(root, "source.csv");
    await writeFile(source, Buffer.alloc(20, 7));
    const partOne = path.join(root, "one.part");
    const partTwo = path.join(root, "two.part");
    const fetchImplementation = vi.fn(
      async (request: string | URL | Request, init?: RequestInit) => {
        const url = String(request);
        if (url.endsWith("/v1/structured/partition-uploads"))
          return Response.json(
            {
              partitionImportJobId: "pjob_1",
              status: "uploading",
              partSize: 16,
              totalParts: 2,
              expiresAt: new Date().toISOString(),
              parts: [
                { partNumber: 1, uploadUrl: pathToFileURL(partOne).href },
                { partNumber: 2, uploadUrl: pathToFileURL(partTwo).href }
              ],
              nextAfterPartNumber: null
            },
            { status: 201 }
          );
        if (url.endsWith("/complete"))
          return Response.json({
            partitionImportJobId: "pjob_1",
            status: "queued",
            partitionCount: 0,
            totalRowCount: 0
          });
        throw new Error(`Unexpected request ${url} ${init?.method}`);
      }
    ) as unknown as typeof fetch;
    const result = await uploadPartitionDataset({
      context: context(fetchImplementation),
      filePath: source,
      name: "source.csv",
      mediaType: "text/csv",
      dataset: "business",
      enterpriseName: "Maijia",
      startDate: "20260907",
      endDate: "20260913",
      idempotencyKey: "idem"
    });
    expect(result).toMatchObject({ partitionImportJobId: "pjob_1", status: "queued" });
    await expect(readFile(partOne)).resolves.toHaveLength(16);
    await expect(readFile(partTwo)).resolves.toHaveLength(4);
    expect(JSON.stringify(result)).not.toContain("uploadUrl");
  });

  it("aborts the server session when a multipart transfer cannot complete", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "launcher-partition-"));
    const source = path.join(root, "source.csv");
    await writeFile(source, "source");
    const methods: string[] = [];
    const fetchImplementation = vi.fn(
      async (request: string | URL | Request, init?: RequestInit) => {
        const url = String(request);
        methods.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/v1/structured/partition-uploads"))
          return Response.json(
            {
              partitionImportJobId: "pjob_abort",
              status: "uploading",
              partSize: 16,
              parts: [{ partNumber: 1, uploadUrl: "https://storage.example/part" }],
              nextAfterPartNumber: null
            },
            { status: 201 }
          );
        if (url === "https://storage.example/part") return new Response(null, { status: 503 });
        if (url.endsWith("/pjob_abort") && init?.method === "DELETE") return Response.json({});
        throw new Error(`Unexpected request ${url}`);
      }
    ) as unknown as typeof fetch;

    await expect(
      uploadPartitionDataset({
        context: context(fetchImplementation),
        filePath: source,
        name: "source.csv",
        mediaType: "text/csv",
        dataset: "business",
        enterpriseName: "Maijia",
        startDate: "20260907",
        endDate: "20260913",
        idempotencyKey: "abort"
      })
    ).rejects.toThrow("failed with 503");
    expect(methods.filter((value) => value.startsWith("PUT "))).toHaveLength(3);
    expect(methods).toContain(
      "DELETE https://hub.example/v1/structured/partition-uploads/pjob_abort"
    );
  });

  it("downloads and verifies a sanitized local extract manifest", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "launcher-partition-"));
    const bytes = Buffer.from("header\nvalue\n");
    const source = path.join(root, "partition.csv");
    await writeFile(source, bytes);
    const fetchImplementation = vi.fn(async () =>
      Response.json({
        dataset: "dishes",
        enterpriseName: "Maijia",
        startDate: "2026-09-07",
        endDate: "2026-09-13",
        partitionCount: 1,
        totalRowCount: 1,
        expiresAt: new Date().toISOString(),
        partitions: [
          {
            businessDate: "2026-09-07",
            storeId: "001",
            storeName: "Store A",
            rowCount: 1,
            byteSize: bytes.length,
            checksumSha256: createHash("sha256").update(bytes).digest("hex"),
            presignedDownloadUrl: pathToFileURL(source).href
          }
        ]
      })
    ) as unknown as typeof fetch;
    const result = (await downloadPartitionDataset({
      context: context(fetchImplementation),
      dataset: "dishes",
      enterpriseName: "Maijia",
      startDate: "20260907",
      endDate: "20260913"
    })) as { localDirectory: string; files: string[] };
    expect(result.files).toHaveLength(1);
    const localManifest = await readFile(path.join(result.localDirectory, "manifest.json"), "utf8");
    expect(localManifest).not.toContain("presignedDownloadUrl");
    expect(localManifest).not.toContain("file://");
    await rm(result.localDirectory, { recursive: true, force: true });
  });

  it("refreshes an expired manifest once before completing the extract", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "launcher-partition-"));
    const bytes = Buffer.from("header\nvalue\n");
    let manifestRequests = 0;
    const fetchImplementation = vi.fn(async (request: string | URL | Request) => {
      const url = String(request);
      if (url.endsWith("/v1/structured/partition-manifests")) {
        manifestRequests += 1;
        return Response.json({
          dataset: "business",
          enterpriseName: "Maijia",
          startDate: "2026-09-07",
          endDate: "2026-09-07",
          partitionCount: 1,
          totalRowCount: 1,
          partitions: [
            {
              businessDate: "2026-09-07",
              storeId: "001",
              storeName: "Store A",
              rowCount: 1,
              byteSize: bytes.length,
              checksumSha256: createHash("sha256").update(bytes).digest("hex"),
              presignedDownloadUrl:
                manifestRequests === 1
                  ? "https://storage.example/expired"
                  : "https://storage.example/fresh"
            }
          ]
        });
      }
      if (url.endsWith("/expired")) return new Response(null, { status: 403 });
      if (url.endsWith("/fresh")) return new Response(bytes, { status: 200 });
      throw new Error(`Unexpected request ${url}`);
    }) as unknown as typeof fetch;

    const result = (await downloadPartitionDataset({
      context: context(fetchImplementation),
      dataset: "business",
      enterpriseName: "Maijia",
      startDate: "20260907",
      endDate: "20260907"
    })) as { localDirectory: string; files: string[] };

    expect(manifestRequests).toBe(2);
    expect(result.files).toHaveLength(1);
    await rm(result.localDirectory, { recursive: true, force: true });
  });
});

function context(fetchImplementation: typeof fetch) {
  return {
    serviceUrl: "https://hub.example",
    accessToken: "secret",
    launcherVersion: "0.4.0",
    fetchImplementation
  };
}
