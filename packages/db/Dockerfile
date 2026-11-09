# syntax=docker/dockerfile:1
# Build context is the repository root:  docker build -f packages/db/Dockerfile .

# ---- Stage 1: build everything ------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@12.6.0

# Manifests first, so the dependency layer is cached until a package.json or the lockfile changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @kanban/db...

COPY packages/db packages/db
RUN pnpm --filter @kanban/db run build

# ---- Stage 2: runtime ---------------------------------------------------------------------
# Carries only the single-file bundle and the SQL migrations: no node_modules, no sources.
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /repo/packages/db/dist ./dist
COPY --from=build --chown=node:node /repo/packages/db/migrations ./migrations
USER node
# Reads /app/.env, which docker-compose mounts read-only; nothing secret is baked into the image.
CMD ["node", "dist/init.mjs"]
