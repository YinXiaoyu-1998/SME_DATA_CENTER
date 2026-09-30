# Staging Server Runtime Prerequisites

This runbook prepares the Alibaba Cloud staging server for later Phase 4
container deployment. It does not deploy the application or store secrets.

## Install

From the repository root on a clean Ubuntu 22.04 host:

```bash
sudo bash scripts/provision-staging-runtime.sh
```

The script installs:

- Docker Engine from Docker's official Ubuntu repository
- Docker Compose and Buildx plugins
- Node.js 22 and npm from the NodeSource repository
- nginx and Git from Ubuntu packages
- bounded Docker JSON log rotation
- an nginx default server that returns HTTP 404 until deployment

## Reverse-proxy boundary

The staging nginx proxy is the only approved hop in front of the API. It sets
`X-Forwarded-For` to its direct peer address (`$remote_addr`) rather than
appending a caller-supplied forwarding chain. nginx returns `404` for public
`/readyz`; direct host-loopback requests remain the only readiness path.

Adding a CDN or load balancer changes this trust boundary and requires a new,
explicit trusted-proxy list in the API and matching proxy configuration.
`trustProxy: true` is not approved.

## Container Registry

The staging server can reach Alibaba Cloud ACR, but direct Docker Hub image and
blob access is unreliable. Do not configure the general ACR registry hostname
as a Docker `registry-mirrors` endpoint; it is a registry, not a transparent
Docker Hub mirror.

Before application deployment, create or select the existing API and worker
ACR repositories in `cn-beijing`, then provide their non-secret registry
hostname, namespace, and repository names. Keep the ACR password outside git
and log in with `docker login --password-stdin`. `release-ops` does not need a
third repository or secret: it is stored as `ops-<12-character-git-sha>` in the
existing API repository.

## Runtime image roles

The API and worker targets are lean, non-root, long-running images. The
`release-ops` target is also non-root but is on-demand only through the Compose
`release` profile; it performs Qdrant initialization, forward-only Prisma
migrations, and compiled staging smoke work before its container is removed.
Do not start it as a persistent service.

All three targets are scanned under the dependency risk policy. New high or
critical findings and any unregistered moderate finding block CI. The current
ExcelJS read-only XLSX exception has a mandatory review date of `2027-01-31`.

## Verify

```bash
systemctl is-active docker nginx
docker version
docker compose version
docker buildx version
node --version
npm --version
nginx -t
ss -lntup
```

Expected state before application deployment:

- Docker and nginx are active and enabled.
- Node.js reports major version 22.
- Docker Compose and Buildx plugins return versions.
- nginx is the only HTTP listener and returns HTTP 404; the application is not
  deployed.

## Rollback

Run rollback only if the runtime installation itself must be removed:

```bash
sudo systemctl disable --now nginx docker
sudo apt-get purge -y \
  docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin nodejs nginx
sudo rm -f \
  /etc/apt/sources.list.d/docker.sources \
  /etc/apt/sources.list.d/nodesource.list \
  /etc/apt/keyrings/docker.asc \
  /etc/apt/keyrings/nodesource.gpg
```

Do not remove `/var/lib/docker` after application deployment without a separate
backup and data-retention decision.

An image rollback restores image/Compose references only. It never reverses a
forward-only Prisma migration; migration compatibility and database recovery
require a separate operations decision.

## PDF release prerequisite and rollback floor

The staging host is **not ready for PDF**. A read-only host check on 2026-09-30
confirmed `x86_64`, 2 CPUs, 1,647,540 KiB total memory (about 1.57 GiB), and
29,311,455,232 bytes of available root disk. Before enabling the PDF profile,
approve and provide at least 12 GiB host memory and 4 CPU cores, then
qualify the full workload on Linux/amd64 with existing services. The parser has
an 8 GiB cgroup ceiling and 4 CPUs; its dedicated single-slot worker has a 1 GiB
ceiling and 1 CPU quota. The 12 GiB recommendation still requires measured
headroom for OS, API, general worker and Qdrant. Local Linux/arm64 synthetic
tests and selected 4- and 19-page originals passed under a 5 GiB parser ceiling;
they do not establish amd64 or full 104-page end-to-end readiness. Deployment
refuses enabled PDF processing when the host prerequisite is absent.

The parser uses `pdf-<SHA>` tags in the existing private Beijing `smedc/api`
repository, so no new console-only ACR repository is required. Its Docker build
context is `services/pdf-parser`, with a locked CPU-only Python dependency set
and manifest-verified build-time public models. Runtime has no external network,
runs UID10001, read-only rootfs, pids128, dropped capabilities and bounded tmpfs.
The private internal bridge is `172.30.96.0/29`, parser `172.30.96.2`; check this
subnet for conflicts before enabling. Only controlled host API/release readiness
and PDF worker use the private endpoint plus Bearer secret; no public port is
published. The general worker receives no parser token.

Release sequence:

1. Deploy the PDF-compatible API, general worker and release-ops with both PDF
   switches false. The deploy guard probes the actual generated `FileType.pdf`,
   packaged scope capability marker and immutable Docker IDs of every reader.
   First initialization is permitted only from a verified PDF-unaware API AND
   worker; missing state on a compatible runtime requires recovery, never an
   inferred empty database or an operator boolean.
2. After resource/full-workload qualification and compatible rollback image
   verification, enable processing and uploads in root-only `runtime.env`, then
   use the canonical GitHub staging deployment. Current AND rollback bundles
   must be compatible. The guard fsyncs the sticky floor before API admission
   can occur and checks authenticated parser readiness before starting PDF
   consumption. API default startup rereads the protected proof per new upload.
3. Rollout EXIT recovery, post-verification recovery and explicit rollback share
   the same guard. Once admission has ever been enabled, every restored Prisma
   reader must remain PDF-compatible even if uploads are disabled or there are
   currently zero PDF rows. Missing/corrupt floor state fails closed. No reverse
   migrations, enum rewrites, customer-row hiding or whole-table freezing occur.

A compatible rollback with PDF processing disabled stops the PDF consumer,
parks only unfinished PDF jobs and preserves each original `availableAt` in
root-only `/opt/smedc/pdf-runtime/parked-runs.json`. Repeated parking retains the
original values and captures newly queued jobs. Compatible processing recovery
restores only exact run/organization/document/attempt identities whose parked
value remains owned; changed/completed runs are untouched. The write-ahead
manifest survives DB/restore failures and is removed only after successful
release. Preserve both runtime proof and parking manifest in host backup and
recovery; never delete them to bypass a failed guard. Disabling the profile
keeps ordinary API health, business traffic and existing PDF reads available.

Launcher 0.7.0 publication/independent verification and server/Skill pin changes
remain separate post-merge release steps.
