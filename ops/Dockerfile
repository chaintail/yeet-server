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
RUN node build.mjs && test -s dist/login.js && test -s dist/fund.js

FROM node:24-slim
ENV NODE_ENV=production
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
