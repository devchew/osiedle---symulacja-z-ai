# syntax=docker/dockerfile:1
#
# Osiedle — multi-stage image.
#   build:   installs dependencies, type-checks and builds the web app (dist/) and the
#            bundled production server (dist-server/prod.js)
#   test:    optional — runs the unit test suite on the build (docker build --target test .)
#   runtime: small Node image with only the built files; no node_modules, no sources, no secrets
#
# Run:  docker run -p 8080:8080 [-e OPENROUTER_API_KEY=…] [-e NEWS_FEEDS=off] osiedle

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
RUN npx vitest run

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=/app/dist
WORKDIR /app

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

CMD ["node", "--enable-source-maps", "dist-server/prod.js"]
