# syntax=docker/dockerfile:1.7

FROM node:22.23.2-bookworm-slim AS build

WORKDIR /app

# This file exists at root only in an allowlist-exported public snapshot. Docker
# fails before dependency installation when invoked from a private checkout.
COPY .devhub-public-snapshot ./
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Fail the image build before packaging a stale/invalid catalog or broken app.
RUN npm run devhub -- validate --check \
    && npm run lint \
    && npm test \
    && npm audit --omit=dev --audit-level=high

FROM node:22.23.2-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="DevHub" \
      org.opencontainers.image.description="Self-hosted service registry and operational map" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production \
    DEVHUB_HOST_ID=devhub-server \
    HOST=0.0.0.0 \
    PORT=3000 \
    HOME=/tmp/devhub \
    WRANGLER_WRITE_LOGS=false \
    WRANGLER_LOG_PATH=/tmp/devhub/wrangler.log \
    MINIFLARE_REGISTRY_PATH=/tmp/devhub/miniflare

WORKDIR /app

RUN groupadd --system --gid 10001 devhub \
    && useradd --system --uid 10001 --gid devhub --home-dir /tmp/devhub --shell /usr/sbin/nologin devhub

# The standalone output contains the built app and only its runtime packages.
# vinext currently over-copies image-size, a build-only dependency with an
# unresolved upstream advisory; the production server does not import it.
COPY --from=build --chown=10001:10001 /app/dist/standalone /app
COPY --from=build --chown=10001:10001 /app/node_modules/react /app/node_modules/react
COPY --from=build --chown=10001:10001 /app/node_modules/react-dom /app/node_modules/react-dom
COPY --from=build --chown=10001:10001 /app/node_modules/scheduler /app/node_modules/scheduler
COPY --from=build --chown=0:0 /app/deploy/docker/healthcheck.mjs /usr/local/libexec/devhub-healthcheck.mjs
RUN rm -rf /app/node_modules/image-size

USER 10001:10001
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "/usr/local/libexec/devhub-healthcheck.mjs"]

CMD ["node", "server.js"]
