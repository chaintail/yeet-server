# One image for every role: node <role>/server.mjs <role> from /app/connector (bootstrap: node as/bootstrap.mjs).
# Build context is the repository root: docker compose -f ops/compose.yml build
FROM node:24-slim AS deps
WORKDIR /app/connector
COPY connector/package.json connector/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-slim AS login
WORKDIR /app/connector/login
COPY connector/login/package.json connector/login/package-lock.json ./
RUN npm ci --no-audit --no-fund
# The whole login folder (node_modules and dist are excluded by Dockerfile.dockerignore), so a new module the
# bundle imports never needs a Dockerfile change.
COPY connector/login/ ./
RUN node build.mjs && test -s dist/login.js && test -s dist/fund.js && test -s dist/sign.js

FROM node:24-slim
# The commit this image is built from; GET /version reports it (compose passes YEET_IMAGE_TAG, the short sha).
ARG SERVER_COMMIT=
ENV NODE_ENV=production YEET_SERVER_COMMIT=${SERVER_COMMIT}
WORKDIR /app/connector
COPY --from=deps /app/connector/node_modules ./node_modules
COPY connector/package.json connector/scope-catalog.mjs ./
COPY connector/shared ./shared
COPY connector/as ./as
COPY connector/core ./core
COPY connector/mcp ./mcp
COPY connector/contracts ./contracts
COPY connector/vendor ./vendor
COPY --from=login /app/connector/login/dist ./login/dist
USER node
ENTRYPOINT ["node"]
