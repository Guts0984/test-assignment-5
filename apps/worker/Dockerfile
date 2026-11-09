# syntax=docker/dockerfile:1
# Build context is the repository root:  docker build -f apps/worker/Dockerfile .

# ---- Stage 1: build everything ------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@12.6.0

# Manifests first, so the dependency layer is cached until a package.json or the lockfile changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY e2e/package.json e2e/
COPY packages/db/package.json packages/db/
COPY packages/env/package.json packages/env/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @kanban/worker...

COPY packages/db packages/db
COPY packages/env packages/env
COPY packages/shared packages/shared
COPY apps/worker apps/worker
RUN pnpm --filter @kanban/worker run build

# ---- Stage 2: runtime ---------------------------------------------------------------------
# Carries only the single-file bundle: no sources, no dependencies.
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/worker/dist ./dist
USER node
# Reads /app/.env, which docker-compose mounts read-only; nothing secret is baked into the image.
CMD ["node", "dist/main.mjs"]
