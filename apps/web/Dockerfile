# syntax=docker/dockerfile:1
# Build context is the repository root:  docker build -f apps/web/Dockerfile .

# ---- Stage 1: build everything ------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@12.6.0

# Manifests first, so the dependency layer is cached until a package.json or the lockfile changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY e2e/package.json e2e/
COPY packages/db/package.json packages/db/
COPY packages/env/package.json packages/env/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @kanban/web...

COPY packages/env packages/env
COPY packages/shared packages/shared
COPY apps/web apps/web
# No .env exists at build time: server code reads its configuration when the first request arrives.
RUN pnpm --filter @kanban/web run build

# ---- Stage 2: runtime ---------------------------------------------------------------------
# Next's standalone output: the server and only the files it needs, no source and no dev tools.
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
COPY --from=build --chown=node:node /repo/apps/web/shutdown.cjs ./apps/web/shutdown.cjs
USER node
# Reads /app/.env (mounted read-only by docker-compose) by walking up from the working directory.
WORKDIR /app/apps/web
EXPOSE 3000
# shutdown.cjs makes SIGTERM end the process cleanly with exit code 0 (see the file).
CMD ["node", "--require", "./shutdown.cjs", "server.js"]
