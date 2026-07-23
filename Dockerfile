FROM node:22-bookworm-slim AS base

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps/admin-web/package.json ./apps/admin-web/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/mcp-launcher/package.json ./apps/mcp-launcher/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/mcp-contract/package.json ./packages/mcp-contract/package.json
COPY packages/storage/package.json ./packages/storage/package.json
COPY packages/structured-ingestion/package.json ./packages/structured-ingestion/package.json
COPY packages/testing/package.json ./packages/testing/package.json

RUN npm install --global npm@11.18.0 \
  && npm ci --include=dev \
  && npm cache clean --force

COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY fixtures ./fixtures

RUN npm run db:generate

ENV NODE_ENV=production

FROM base AS api

ENV HOST=127.0.0.1
ENV PORT=3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "run", "api:dev"]

FROM base AS worker

USER node

CMD ["npm", "run", "worker:dev"]
