# Staging Server Runtime Prerequisites

This runbook prepares a new or recovered Alibaba Cloud staging host for the current container runtime. It does not deploy the application or store secrets.

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

All three targets are scanned under the current dependency risk policy. Quality CI reports audit findings while other gates remain blocking; staging deployment and launcher publication keep their own enforcement. See dependency-risk-register.md and config/dependency-risk-acceptance.json; there are currently no accepted exceptions.

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

## Ledger PDF worker prerequisite

The worker image installs LibreOffice Calc, Noto CJK fonts and Poppler, with
ExcelJS/Sharp limited to the worker dependency set. AMD64 CI executes the
packaged synthetic renderer check with no network and a writable temporary
filesystem. Before an authorized deployment, prepare `/opt/smedc/ledger-pdf`
writable by the image's node UID (normally 1000) for its Compose mount at
`/var/lib/smedc/ledger-pdf`. Check disk capacity for bounded photo/PDF scratch and
keep only the configured worker's scratch directory under lease-aware cleanup.

API/release-ops do not need Office or fonts. Release-ops includes the compiled
`node dist/release/ledger-pdf.js` CLI. Both delivery and daily reconciliation stay
disabled until authorized backfill and content/coverage verification; see
[ledger-pdf-operations.md](./ledger-pdf-operations.md).
