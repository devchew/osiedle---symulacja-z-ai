# syntax=docker/dockerfile:1
#
# Osiedle — multi-stage image.
#   build:   installs dependencies, type-checks and builds the web app (dist/) and the
#            bundled production server (dist-server/prod.js)
#   test:    optional — runs the unit test suite on the build (docker build --target test .)
#   runtime: small Node image with only the built files; no node_modules, no sources, no secrets
#
# Run:  docker run -p 8080:8080 -v osiedle-data:/app/data [-e OPENROUTER_API_KEY=…] [-e NEWS_FEEDS=off] osiedle
# The four live worlds (server/worlds.ts) save their state to /app/data every 5 min and on stop:
# mount a persistent volume there, otherwise each restart begins new worlds.

ARG NODE_IMAGE=node:24-alpine

# ---------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# dependencies first, so this layer is cached until package*.json changes
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# ---------------------------------------------------------------- test (optional target)
FROM build AS test
# generous timeouts: the soak / tools suites simulate whole weeks and builders are often slow
RUN npx vitest run --testTimeout=60000 --hookTimeout=120000

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=/app/dist \
    DATA_DIR=/app/data
WORKDIR /app

# live world snapshots (mount a volume here; a fresh named volume inherits this owner)
RUN mkdir -p /app/data && chown node:node /app/data

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server

USER node
EXPOSE 8080
# SIGTERM saves the live worlds (a few hundred kB each) before exiting
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

CMD ["node", "--enable-source-maps", "dist-server/prod.js"]
