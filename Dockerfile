# Keep compilation on the build host: Vite's native tooling is unreliable under
# QEMU emulation. Runtime dependencies are installed separately for the target
# architecture below.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/plugin-cli/package.json packages/plugin-cli/package.json
COPY packages/plugin-sdk/package.json packages/plugin-sdk/package.json
COPY packages/ranking/package.json packages/ranking/package.json
COPY packages/rss/package.json packages/rss/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci

COPY . .

RUN --mount=type=secret,id=dibao_sentry_config,target=/app/config/sentry.json,required=false npm run build

FROM --platform=$TARGETPLATFORM node:22-bookworm-slim AS production-dependencies

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/plugin-cli/package.json packages/plugin-cli/package.json
COPY packages/plugin-sdk/package.json packages/plugin-sdk/package.json
COPY packages/ranking/package.json packages/ranking/package.json
COPY packages/rss/package.json packages/rss/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci && npm prune --omit=dev

FROM --platform=$TARGETPLATFORM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.licenses="BUSL-1.1" \
  com.dibao.license.change-license="Apache-2.0" \
  com.dibao.license.change-date="2030-07-12"

ENV NODE_ENV=production \
  DIBAO_HOST=0.0.0.0 \
  DIBAO_PORT=8080 \
  DIBAO_DATABASE_PATH=/data/dibao.sqlite \
  DIBAO_COOKIE_SECURE=false

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data \
  && chown -R node:node /data /app

COPY --from=builder --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=builder --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=builder --chown=node:node /app/.dibao ./.dibao
COPY --from=builder --chown=node:node /app/packages ./packages
COPY --from=builder --chown=node:node /app/plugins ./plugins

USER node

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=15s --start-period=20s --retries=3 CMD ["node", "-e", "const port=process.env.DIBAO_PORT||'8080'; fetch(`http://127.0.0.1:${port}/api/system/health`).then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1));"]

CMD ["node", "apps/server/dist/container-entrypoint.js"]
