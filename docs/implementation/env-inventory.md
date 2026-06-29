# 企业资料中枢 Environment Inventory

This file tracks required variables and external services. Do not store secret values here.

## Local Development

| Variable               |                        Required | Example / Default                                                                    | Secret? | Used By                    | Notes                                                                       |
| ---------------------- | ------------------------------: | ------------------------------------------------------------------------------------ | ------: | -------------------------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`         |                             Yes | `mysql://enterprise_hub:enterprise_hub_local_password@localhost:3306/enterprise_hub` |     Yes | Future API, worker, Prisma | Local-only example is in `.env.example`; replace for personal environments. |
| `STORAGE_DRIVER`       |                             Yes | `local`                                                                              |      No | Future storage package     | Day 0 only records the contract; adapter implementation starts later.       |
| `LOCAL_STORAGE_ROOT`   | Yes when `STORAGE_DRIVER=local` | `./.data/storage`                                                                    |      No | Future storage package     | `.data/` is ignored by git.                                                 |
| `JWT_SECRET`           |                             Yes | `replace-with-local-development-secret`                                              |     Yes | Future auth module         | Development value only; production must come from a secret store.           |
| `DEV_SEED_ADMIN_EMAIL` |                             Yes | `admin@example.com`                                                                  |      No | Future seed script         | Used for local seed data in later phases.                                   |

## Local Docker Compose

| Variable              | Required | Default                              | Secret? | Used By              | Notes                                                          |
| --------------------- | -------: | ------------------------------------ | ------: | -------------------- | -------------------------------------------------------------- |
| `MYSQL_DATABASE`      |       No | `enterprise_hub`                     |      No | `docker-compose.yml` | Local container database name.                                 |
| `MYSQL_USER`          |       No | `enterprise_hub`                     |      No | `docker-compose.yml` | Local container user.                                          |
| `MYSQL_PASSWORD`      |       No | `enterprise_hub_local_password`      |     Yes | `docker-compose.yml` | Development-only default, not suitable outside local machines. |
| `MYSQL_ROOT_PASSWORD` |       No | `enterprise_hub_local_root_password` |     Yes | `docker-compose.yml` | Development-only default, not suitable outside local machines. |
| `MYSQL_PORT`          |       No | `3306`                               |      No | `docker-compose.yml` | Override if port 3306 is busy locally.                         |

## Human-Provided Inputs

No human-provided external service, API key, domain, OSS bucket, online MySQL, or deployment credential is required for Phase 1 / Day 0.
