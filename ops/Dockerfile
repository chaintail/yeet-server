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
COPY connector/login/src.jsx connector/login/fund.jsx connector/login/privy-app.jsx connector/login/fund-balance.js connector/login/build.mjs ./
RUN node build.mjs

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
