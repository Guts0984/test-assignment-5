# syntax=docker/dockerfile:1
# Build context is the repository root:  docker build -f apps/api/Dockerfile .

# ---- Stage 1: build everything ------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@12.6.0

# Manifests first, so the dependency layer is cached until a package.json or the lockfile changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/env/package.json packages/env/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @kanban/api...

COPY packages/db packages/db
COPY packages/env packages/env
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @kanban/api run build

# The single-file bundle needs exactly one package at run time: the Swagger UI static assets.
RUN set -eu; \
    swagger_dir="$(cd apps/api && node -e "const { createRequire } = require('node:module'); \
      const fromSwagger = createRequire(require.resolve('@nestjs/swagger/package.json')); \
      console.log(require('node:path').dirname(fromSwagger.resolve('swagger-ui-dist/package.json')))")"; \
    mkdir -p /out/node_modules; \
    cp -r "$swagger_dir" /out/node_modules/swagger-ui-dist; \
    find /out/node_modules/swagger-ui-dist \( -name '*.map' -o -name '*.md' \) -delete

# ---- Stage 2: runtime ---------------------------------------------------------------------
# Carries only the bundle and the Swagger assets: no sources, no dev dependencies.
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
COPY --from=build --chown=node:node /out/node_modules ./node_modules
USER node
EXPOSE 3001
# Reads /app/.env, which docker-compose mounts read-only; nothing secret is baked into the image.
CMD ["node", "dist/main.mjs"]
