# Alibaba Cloud OSS Storage Adapter

Current storage contract. Both generic original objects and business/dishes multipart/canonical partitions are implemented. Deployment evidence is maintained in [staging readiness](staging-readiness.md).

## Decision

SMEDC keeps the existing `StorageAdapter` boundary and selects one implementation at API/worker startup:

- `STORAGE_DRIVER=local` creates `LocalFileSystemStorageAdapter` and requires `LOCAL_STORAGE_ROOT`.
- `STORAGE_DRIVER=oss` creates `AliyunOssStorageAdapter` and requires the S3-compatible Alibaba Cloud OSS runtime variables documented in `env-inventory.md`.
- Missing required variables and unsupported driver names fail before the first storage request.

The storage driver is selected independently of the public MCP/HTTP contracts. Backend authorization, document metadata, processing runs, and audits remain in MySQL; only the original-file byte store changes.

## Object Identity And Isolation

Database records keep the existing provider-neutral logical key:

```text
org/<org_id>/documents/<document_id>/original/<safe_filename>
```

The OSS adapter maps that key to a physical object below `AWS_S3_PREFIX`, which defaults to:

```text
smedc/org/<org_id>/documents/<document_id>/original/<safe_filename>
```

The prefix is deliberately not returned to API callers or persisted as business metadata. It isolates SMEDC objects inside a shared bucket without coupling stored document records to one deployment prefix. Prefixes and logical keys reject absolute paths, backslashes, empty segments, `.` segments, and `..` traversal.

## Adapter Semantics

`AliyunOssStorageAdapter` matches the local adapter contract:

- `putObject` publishes exact bytes, content type, byte size, and SHA-256 metadata;
- `statObject` returns size, content type, and SHA-256, with a read/hash fallback for compatible objects missing adapter metadata;
- `getObjectStream` returns the SDK response stream;
- `createDownloadUrl` returns a time-limited presigned GET URL, 900 seconds by default;
- `deleteObject` removes the physical object.

Uploads are already bounded and materialized by the API/MCP upload paths. The OSS adapter collects a generic input stream into a buffer before `PutObject` so it can publish an exact `Content-Length` and SHA-256 metadata compatible with Alibaba OSS. The current default maximum upload is 50 MiB.

The `business` / `dishes` path keeps the generic 50 MiB buffer separate. It uses a
separate launcher-owned multipart upload session for temporary source objects and a worker-owned
streaming path for immutable canonical partition objects. Logical keys remain provider-neutral and
opaque; enterprise and store names stay in authorized MySQL metadata rather than OSS paths. A short
transaction publishes new current pointers before old object keys enter a retryable deletion
outbox, so no old object is a readable version.

The SDK disables optional request/response checksum calculation unless required because the service records its own SHA-256 and the Alibaba endpoint is S3-compatible rather than AWS S3 itself.

## Runtime And Readiness

Both API and worker call the same storage factory after `.env` loading. The worker therefore reads from the same backend to which the API uploaded. Readiness creates one small object through the selected adapter, validates its metadata, and deletes it in `finally`.

The gated `npm run test:storage:oss` suite verifies PUT, HEAD/stat, SDK GET, presigned GET, DELETE, and post-delete absence against the ignored local OSS configuration. It must be run only after explicitly loading `.env`; tests and logs never print credentials or signed URLs.

## Compatibility And Migration Boundary

Local mode remains supported and is still the committed `.env.example` default. Switching a running dataset from `local` to `oss` does not migrate historical bytes: existing database object keys are provider-neutral, but the bytes remain in their former backend. Operators must either keep the old driver available while those documents matter or perform a separately designed, verified migration before expecting OSS-only reads.

`npm run purge-data` remains local-only. It must not become a broad OSS deletion command without a separate retention, authorization, audit, backup, and recovery design.

## Client byte integrity

Clients supply original bytes without reconstruction. The official launcher owns local file reads and multipart transport; the base Skill does not repair datasets or receive internal storage credentials/partition URLs. Upload and download semantics are defined in [API/MCP](api-contract.md) and [current partitions](structured-partitions.md).
