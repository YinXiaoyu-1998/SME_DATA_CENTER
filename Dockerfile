FROM node:22-bookworm-slim AS manifests

WORKDIR /app

RUN npm install --global npm@11.18.0

COPY package.json package-lock.json tsconfig.json tsconfig.base.json tsup.release.config.ts ./
COPY apps/admin-web/package.json ./apps/admin-web/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/mcp-launcher/package.json ./apps/mcp-launcher/package.json
COPY apps/release-ops/package.json ./apps/release-ops/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/mcp-contract/package.json ./packages/mcp-contract/package.json
COPY packages/storage/package.json ./packages/storage/package.json
COPY packages/structured-ingestion/package.json ./packages/structured-ingestion/package.json
COPY packages/testing/package.json ./packages/testing/package.json

FROM manifests AS build

RUN npm ci --include=dev --legacy-peer-deps \
  && npm cache clean --force

COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY fixtures ./fixtures

RUN npm run db:generate \
  && npm run build:release

FROM manifests AS api-deps

RUN npm ci --omit=dev --legacy-peer-deps \
  --workspace @enterprise-hub/api --include-workspace-root=false \
  && npm cache clean --force

FROM manifests AS worker-deps

RUN npm ci --omit=dev --legacy-peer-deps \
  --workspace @enterprise-hub/worker --include-workspace-root=false \
  && npm cache clean --force

FROM manifests AS release-ops-deps

RUN npm ci --omit=dev --legacy-peer-deps \
  --workspace @enterprise-hub/release-ops --include-workspace-root=false \
  && npm cache clean --force

FROM node:22-bookworm-slim AS runtime-base

WORKDIR /app

RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

FROM runtime-base AS api

ENV HOST=127.0.0.1
ENV PORT=3000

COPY --from=api-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=node:node /app/dist/release/api.js ./dist/release/api.js

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/release/api.js"]

FROM runtime-base AS worker

COPY --from=worker-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=node:node /app/dist/release/worker.js ./dist/release/worker.js

USER node

CMD ["node", "dist/release/worker.js"]

FROM runtime-base AS release-ops

COPY --from=release-ops-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node packages/db/prisma.config.ts ./packages/db/prisma.config.ts
COPY --chown=node:node packages/db/prisma ./packages/db/prisma
COPY --from=build --chown=node:node /app/dist/release/readiness.js ./dist/release/readiness.js
COPY --from=build --chown=node:node /app/dist/release/staging-smoke.js ./dist/release/staging-smoke.js
COPY --chown=node:node fixtures/evidence/kitchen-sop.md ./fixtures/evidence/kitchen-sop.md
COPY --chown=node:node fixtures/evidence/shift-notes.txt ./fixtures/evidence/shift-notes.txt

USER node

CMD ["node", "dist/release/readiness.js"]
