# Staging Server Runtime Prerequisites

This runbook prepares the Alibaba Cloud staging server for later Phase 3
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

## Container Registry

The staging server can reach Alibaba Cloud ACR, but direct Docker Hub image and
blob access is unreliable. Do not configure the general ACR registry hostname
as a Docker `registry-mirrors` endpoint; it is a registry, not a transparent
Docker Hub mirror.

Before application deployment, create or select an ACR repository in
`cn-beijing`, then provide its non-secret registry hostname, namespace, and
repository names. Keep the ACR password outside git and log in with
`docker login --password-stdin`.

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
