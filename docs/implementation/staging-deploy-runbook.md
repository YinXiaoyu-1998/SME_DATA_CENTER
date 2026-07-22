# Phase 4 Staging Deploy Runbook

This runbook describes the Phase 4 staging skeleton deployment. It is safe to
commit because it contains no runtime secrets.

## Scope

- API and worker run as Docker containers on the Alibaba Cloud Simple
  Application Server.
- Qdrant runs as a Docker container with a local Docker volume.
- MySQL is Alibaba Cloud RDS, not a local container.
- Images are pulled from an account-owned Beijing ACR private registry with
  immutable git-SHA tags.
- nginx publicly exposes `api.smedatacenter.xyz`; `/readyz` remains local-only.

## Runtime files

The server runtime directory is `/opt/enterprise-hub`.

| File                                             | Git source                                       | Secret? | Required mode       |
| ------------------------------------------------ | ------------------------------------------------ | ------- | ------------------- |
| `/opt/enterprise-hub/docker-compose.yml`         | `deploy/staging/docker-compose.yml`              | No      | `0644`              |
| `/etc/nginx/sites-available/enterprise-hub.conf` | `deploy/staging/nginx-enterprise-hub.conf`       | No      | `0644`              |
| `/opt/enterprise-hub/runtime.env`                | Generated from Keychain and local ignored `.env` | Yes     | `root:root`, `0600` |

`deploy/staging/docker-compose.yml` defaults to that runtime env path. For
local syntax checks, set `ENTERPRISE_HUB_RUNTIME_ENV_FILE` to an empty temporary
file instead of creating `/opt/enterprise-hub/runtime.env` locally.

## Required runtime env names

`runtime.env` must include these values without printing or committing them:

- `DATABASE_URL`
- `JWT_SECRET`
- `STORAGE_DRIVER=oss`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION`
- `AWS_ENDPOINT`
- `AWS_S3_BUCKET`
- `QDRANT_URL=http://127.0.0.1:6333`
- `QDRANT_COLLECTION_EVIDENCE=enterprise_hub_evidence_staging`
- `LLM_PROVIDER=openai-compatible`
- `OPENAI_COMPATIBLE_API_KEY`
- `OPENAI_COMPATIBLE_BASE_URL`
- `LLM_MODEL`
- `LLM_EMBEDDING_MODEL`
- `LLM_EMBEDDING_DIMENSION`
- `RERANK_PROVIDER=dashscope`
- `DASHSCOPE_API_BASE_URL`
- `EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED=true`
- `ENTERPRISE_HUB_API_IMAGE`
- `ENTERPRISE_HUB_WORKER_IMAGE`
- `ENTERPRISE_HUB_QDRANT_IMAGE`

## Deployment sequence

1. Build and push the API, worker, and Qdrant images to ACR using the current
   git commit SHA as the tag. The staging server is `linux/amd64`; do not push
   the local default Apple Silicon image as the deploy tag.

   ```bash
   git_sha="$(git rev-parse --short=12 HEAD)"
   docker buildx build --platform linux/amd64 --target api -t "${ENTERPRISE_HUB_ACR_REGISTRY}/${ENTERPRISE_HUB_ACR_NAMESPACE}/api:${git_sha}" --push .
   docker buildx build --platform linux/amd64 --target worker -t "${ENTERPRISE_HUB_ACR_REGISTRY}/${ENTERPRISE_HUB_ACR_NAMESPACE}/worker:${git_sha}" --push .
   docker pull --platform linux/amd64 qdrant/qdrant:v1.15.4
   docker tag qdrant/qdrant:v1.15.4 "${ENTERPRISE_HUB_ACR_REGISTRY}/${ENTERPRISE_HUB_ACR_NAMESPACE}/qdrant:v1.15.4"
   docker push "${ENTERPRISE_HUB_ACR_REGISTRY}/${ENTERPRISE_HUB_ACR_NAMESPACE}/qdrant:v1.15.4"
   ```

2. Install `deploy/staging/docker-compose.yml` to
   `/opt/enterprise-hub/docker-compose.yml`.
3. Install the generated root-only `/opt/enterprise-hub/runtime.env`.
4. Run `docker compose --env-file /opt/enterprise-hub/runtime.env -f /opt/enterprise-hub/docker-compose.yml pull`.
5. Start Qdrant and initialize the collection:

   ```bash
   docker compose --env-file /opt/enterprise-hub/runtime.env -f /opt/enterprise-hub/docker-compose.yml up -d qdrant
   docker compose --env-file /opt/enterprise-hub/runtime.env -f /opt/enterprise-hub/docker-compose.yml run --rm api npm run qdrant:init
   ```

6. Apply schema and seed only synthetic data:

   ```bash
   docker compose --env-file /opt/enterprise-hub/runtime.env -f /opt/enterprise-hub/docker-compose.yml run --rm api npm run db:migrate:deploy
   docker compose --env-file /opt/enterprise-hub/runtime.env -f /opt/enterprise-hub/docker-compose.yml run --rm api npm run db:seed
   ```

7. Start API and worker:

   ```bash
   docker compose --env-file /opt/enterprise-hub/runtime.env -f /opt/enterprise-hub/docker-compose.yml up -d
   ```

8. Validate local-only readiness and public liveness:

   ```bash
   curl -fsS http://127.0.0.1:3000/healthz
   curl -fsS http://127.0.0.1:3000/readyz
   ```

9. Install nginx config, request a Let's Encrypt certificate through certbot,
   and run `certbot renew --dry-run`.
10. Run the fixture-only staging smoke:

    ```bash
    STAGING_SMOKE_API_URL=https://api.smedatacenter.xyz npm run staging:smoke
    ```

## Rollback

Rollback is tag based:

1. Put the previous `ENTERPRISE_HUB_API_IMAGE` and
   `ENTERPRISE_HUB_WORKER_IMAGE` tags back into `/opt/enterprise-hub/runtime.env`.
2. Pull and restart:

   ```bash
   docker compose --env-file /opt/enterprise-hub/runtime.env -f /opt/enterprise-hub/docker-compose.yml pull api worker
   docker compose --env-file /opt/enterprise-hub/runtime.env -f /opt/enterprise-hub/docker-compose.yml up -d api worker
   ```

Do not delete the Qdrant volume or RDS data during a routine image rollback.
