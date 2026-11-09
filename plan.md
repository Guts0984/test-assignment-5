# Plan: Team Kanban Board

Working agreement

- I write one block, you review it, then I move on. **I never commit or push; you do.** Each block ends with a suggested commit message.
- **NestJS code uses classes** (modules, controllers, services, guards, filters, gateways). **Everything else is functional**: `worker`, `shared`, `web`, the Drizzle schema and db helpers, tests, scripts. No classes outside `apps/api`.
- **Frontend is feature-based** (see "Web architecture").
- All code, comments, README and UI text are in English.
- Package versions are verified at install time (not from memory); the ones I pin go in the block summary.
- Anything ambiguous in the assignment is decided here and recorded in the README "Decisions" section.

---

## 0. Cross-cutting decisions

### Repo and tooling

- **pnpm workspaces**, one `pnpm-lock.yaml` at the root. Node 22 pinned in `.nvmrc`, `engines`, Dockerfiles and CI (local machine has Node 24; code must not depend on 24 features).
- **Typecheck works before any build.** `packages/shared` exposes
  `exports: { ".": { "types": "./src/index.ts", "default": "./dist/index.js" } }`.
  TypeScript resolves `types` to source, so root `pnpm typecheck` needs no build. Runtime (api, worker, Next) uses the built `dist`; dev scripts run `shared` in watch mode, Dockerfiles build it first.
- TypeScript `strict` plus `noUncheckedIndexedAccess`, a shared `tsconfig.base.json`, and `tsc --noEmit` per package driven from the root.
- ESLint flat config: `no-explicit-any` error, `ban-ts-comment` (only with description), `react-hooks`, `@next/next`, `jsx-a11y`, and import-boundary rules for the web features. A `no-classes` rule outside `apps/api`.
- Prettier, `.editorconfig`, `.gitignore`.
- **No secrets in code, Dockerfiles or compose.** Compose reads everything from `.env`; `.env.example` holds dev-only placeholder values (the only manual step is `cp .env.example .env`).

### Order of cards (fractional index)

- `cards.position` is a text key from the `fractional-indexing` algorithm, `COLLATE "C"` (byte-wise ordering, identical in every environment). Order is `(position, id)`, so ties are impossible.
- Unique index on `(column_id, position)` is a safety net; the lock below prevents hitting it.
- `POST /cards/:id/move` body: `{ columnId, beforeId?, afterId?, version? }`. Neighbors are **ids, not positions**; the server resolves their _current_ positions inside the transaction.
- **Concurrency:** the transaction takes `pg_advisory_xact_lock(hash(target column id))` (and the source column in a stable order when different, to avoid deadlocks). All moves into one column are serialized, so every client converges on the same order, the one in the database.
- **Anchor already moved:** the card is placed immediately after `afterId` (else immediately before `beforeId`) at that anchor's _current_ position, so the order stays valid. No error, no 5xx. If an anchor was deleted or sits in another column, the card goes to the nearest valid place (end of column) and the response says so. Never a 5xx, never a corrupt order.
- **10,000 moves between the same two neighbors:** keys grow by about one character per few moves. When a key exceeds a length cap (64), that column is **rebalanced** in the same transaction under the lock (the only case that rewrites other cards), and a `column.rebalanced` event makes clients refetch that column. Documented in the README.

### Permissions

- Roles `owner > editor > viewer`.
- One `WorkspaceAccessService` resolves _entity → workspace → membership_. Every endpoint goes through a guard that loads the entity's workspace and the caller's membership. **No membership → `404`** (same body as "not found", no existence leak). Membership but too low a role → `403`.
- Search, attachments, activity and comments all use the same service; there is no endpoint-specific access code.
- Socket events go through the same service on every event (cached membership with immediate invalidation on member removal, see Realtime).

### Realtime

- Socket.IO with websocket-only transport (no long polling, so no sticky sessions behind nginx), Redis adapter, auth from the session cookie, rooms `board:{id}`.
- **Echo handling:** every mutation carries a `clientMutationId`. Server events carry it back plus the entity `version`. The client ignores events whose `version` is not newer than the cached one and skips patching for its own pending mutation ids.
- **Revocation:** removing a member publishes a Redis message; each api instance disconnects that user's sockets from the workspace's boards. In addition every incoming socket event re-checks membership against a short-TTL cache that the removal invalidates.
- **Presence:** a Redis sorted set per board (member, score = last heartbeat). Heartbeat every 3 s, entries older than 8 s are dropped on read, explicit removal on `disconnect`. A closed tab disappears within 10 s even if the process crashed.
- Per-socket token bucket for incoming messages; exceeding it drops messages and eventually disconnects.
- Reconnect: client re-subscribes, server sends the full current board snapshot; client replaces the cache.

### Rate limiting

- Redis-backed (Lua sliding window), shared by both api instances.
- Key is the real client IP. nginx **overwrites** `X-Real-IP` with `$remote_addr` and the api trusts only that header (never `X-Forwarded-For` from the client).
- Stricter limit on `/auth/*`.

### Attachments

- `POST /cards/:id/attachments` validates declared name, size ≤ 10 MB and declared type, creates a `pending` row and returns an S3 **presigned POST policy** (`content-length-range` enforces 10 MB on the MinIO side).
- `POST /attachments/:id/complete` does a `HEAD` and reads the **first bytes from MinIO** (ranged GET), sniffs the real type with `file-type`, allows only images and PDF, checks the size, then marks `ready`. A renamed `.exe` fails here and the object is deleted.
- MinIO is reached through nginx on the same public origin at `/<bucket>/...` with `Host` preserved (SigV4 signs host and path, so no path rewriting). Downloads: an endpoint returns a presigned GET valid 300 s.
- Worker deletes pending uploads older than 1 h and files of deleted cards (soft delete, then cleanup).

### Mail (worker)

- Invite emails: queued job, unique `jobId`, sent via Mailpit SMTP.
- Mention digest: a `mention_events` table. The first unsent mention for a user schedules one delayed job with `jobId = digest:{userId}` (collection window, default 60 s, env-configurable). The job claims all pending rows in one transaction (`UPDATE ... RETURNING`), enforces `last_digest_sent_at + 15 min`, sends one mail, records it. If the 15-minute window has not elapsed it re-delays itself. Idempotent: the claim is atomic and a unique key on the delivery row prevents double sending after a restart.

### Resilience

- `pg` Pool with `statement_timeout`, `connectionTimeoutMillis`, `idle_in_transaction_session_timeout`, and an `error` handler so a killed Postgres never crashes the process. `ioredis` with retry strategy, `commandTimeout`, and `error` handlers. S3 client with request timeouts.
- `GET /health` = liveness only (no dependencies). `GET /ready` = Postgres + Redis + MinIO checks with timeouts; returns 503 while a dependency is down, process stays alive.
- `SIGTERM`: Nest `enableShutdownHooks`, stop accepting connections, drain in-flight requests, close sockets/pool/Redis, `exit(0)`. The same for worker (close BullMQ worker, wait for active job).
- nginx resolves `api` through Docker DNS with a short `valid=` and a variable `proxy_pass`, so recreated `api` containers work without restarting nginx.

---

## 1. Repository layout

```
apps/
  api/        NestJS (classes)
  worker/     BullMQ (functional)
  web/        Next.js (feature-based, functional)
packages/
  shared/     Zod schemas, types, socket event contracts, error codes (functional)
  # db schema lives in apps/api? -> see decision below
infra/
  nginx/  docker/  scripts/
e2e/          Playwright
.github/workflows/
plan.md  README.md  .env.example
```

**Decision: db package.** The Drizzle schema and migrations are used by `api`, `worker` and the seed. They go in a fourth workspace package `packages/db` (schema, migrations, client factory, seed). The assignment lists four directories "approximately"; adding one internal package avoids api↔worker imports. Noted in the README.

---

## 2. Web architecture (feature-based)

```
apps/web/src/
  app/                          # routing only; pages are thin and compose features
    (auth)/login, register
    (app)/page.tsx              # /
    (app)/boards/[id]/layout.tsx          # renders {children} and {modal}
    (app)/boards/[id]/page.tsx
    (app)/boards/[id]/@modal/(.)cards/[cardId]/page.tsx   # intercepting route
    (app)/boards/[id]/cards/[cardId]/page.tsx             # direct visit = full page
    (app)/search, workspaces/[id]/settings, invite/[token]
    loading.tsx / error.tsx at every segment
  features/
    auth/          api/ components/ hooks/ model/ actions/ index.ts
    workspaces/    (list, members, invites, settings actions)
    boards/        (board view, columns, card tile, dnd, virtualization)
    cards/         (card form with RHF+Zod, conflict panel, detail)
    comments/
    attachments/
    search/
    presence/
    realtime/      (socket client, event -> query-cache patchers)
  shared/
    ui/            (shadcn components)
    lib/           (api client, query client, env, utils)
    hooks/
```

Rules, enforced by lint:

- `app/` imports from `features/*` public `index.ts` only.
- A feature imports from `shared/` and from other features **only through their public `index.ts`**; no deep imports and no cycles.
- Query keys and invalidation live in each feature's `api/keys.ts`; socket patchers in `features/realtime` call each feature's exported cache helpers.
- `'use client'` only on interactive leaves. Server env is read in `shared/lib/env.server.ts` guarded by `server-only`; only `NEXT_PUBLIC_*` reaches the client.
- Pages server-fetch with the forwarded session cookie against `API_INTERNAL_URL` and hand data to TanStack Query via `HydrationBoundary`.
- 1,000 cards: per-column virtualization (`@tanstack/react-virtual`) combined with dnd-kit, memoized card tiles, stable callbacks. This combination is the riskiest UI piece, so it gets an early spike inside block 14.
- Accessibility: labeled inputs, `aria-describedby`/`aria-invalid` on errors, focus management in the modal, dnd-kit keyboard sensor with live-region announcements.

---

## 3. Blocks (each ends at a review gate)

Each block ships its own tests, so the tests are reviewed with the code they cover.

| #   | Block                                    | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Skeleton and tooling**                 | pnpm workspace, tsconfig base, ESLint/Prettier, root scripts (`typecheck`, `lint`, `test`, `build`), `.env.example`, `.nvmrc`, `.gitignore`. Empty packages that typecheck.                                                                                                                                                                                                                                                                                                                                          |
| 2   | **`packages/shared`**                    | Zod schemas for every request/response, role and error enums, unified error shape, socket event contracts, pagination/cursor schemas, mention parsing helper. Built `dist` plus source-typed `exports`. Unit tests.                                                                                                                                                                                                                                                                                                  |
| 3   | **`packages/db`: schema and migrations** | Drizzle schema: users, sessions-less (sessions in Redis), workspaces, memberships, invites, boards, columns, cards (position, version, soft delete), comments, mentions, attachments, activity_log, mention_events, email deliveries. Indexes, FTS (`tsvector` generated columns with GIN for cards and comments), constraints, generated migration, migrate runner with an advisory lock. Position/rebalance helpers. Tests on real Postgres (Testcontainers): constraints, FTS, ordering after thousands of moves. |
| 4   | **Seed**                                 | Idempotent seed: 2 workspaces, 4 users with distinct roles, 3 boards × 5 columns, 1,000 cards on one board with valid positions. Credentials listed in README.                                                                                                                                                                                                                                                                                                                                                       |
| 5   | **API core**                             | Nest bootstrap, config validation, `ZodValidationPipe`, global exception filter (unified format, no 5xx on bad input, NUL-byte rejection), Swagger `/docs`, `/health` and `/ready`, DB/Redis/S3 modules with timeouts and error handlers, rate limiter, graceful shutdown, request logging. Tests incl. Testcontainers harness.                                                                                                                                                                                      |
| 6   | **Auth and workspaces**                  | Register/login/logout/`GET /me` with Redis sessions and `httpOnly` cookie (`COOKIE_SECURE` env-driven), password hashing (argon2), workspaces, invites, accept, member role change and removal, `WorkspaceAccessService` and guards. Tests: roles matrix, foreign workspace → 404, invite rules.                                                                                                                                                                                                                     |
| 7   | **Boards, cards, move, activity**        | `GET /boards/:id`, card CRUD with `version`/409, move endpoint with advisory locks, activity log with cursor pagination. Tests: concurrent moves (many parallel requests converge), moved-anchor case, 10,000 moves between two neighbors, 409, viewer denied.                                                                                                                                                                                                                                                       |
| 8   | **Comments, attachments, search**        | Comments with `@user` mentions (writes `mention_events`), attachment presign/complete with content sniffing, download URLs, search with `ts_rank`, `ts_headline` highlighting, keyset cursor, workspace scoping. Tests: exe-as-png, 11 MB, signed URL expiry, search leaks.                                                                                                                                                                                                                                          |
| 9   | **Realtime**                             | Socket.IO gateway (class), Redis adapter, session auth, board subscription authorization, event broadcast from services, presence, reconnect snapshot, revocation, per-socket rate limit. Tests: two api instances through Testcontainers, revoked member stops receiving.                                                                                                                                                                                                                                           |
| 10  | **Worker**                               | BullMQ queues, invite mail, mention digest, cleanup jobs (pending uploads > 1 h, deleted-card files), graceful shutdown, idempotency. Tests against real Redis, Postgres and a Mailpit container.                                                                                                                                                                                                                                                                                                                    |
| 11  | **Infra**                                | Multi-stage Dockerfiles (non-root, `output: 'standalone'`), compose with all services, one-shot `init` service (migrate, bucket create, seed once under an advisory lock), nginx config (API, web, WebSocket, MinIO path, `X-Real-IP`, Docker DNS re-resolve), healthchecks, only nginx and Mailpit UI published. Manual verification of acceptance checks 1, 15, 16.                                                                                                                                                |
| 12  | **Web foundation**                       | Next.js setup, Tailwind, shadcn/ui, feature folder skeleton and lint boundaries, API client, QueryClient, server env guard, auth pages and session handling, `/` page, loading/error boundaries, MSW setup.                                                                                                                                                                                                                                                                                                          |
| 13  | **Board page**                           | Server-fetched board, hydration, columns/cards, dnd-kit (pointer and keyboard), optimistic move with rollback and toast, role-gated drag, virtualization spike with 1,000 cards, socket client and cache patchers, presence list. MSW tests: optimistic move + rollback, echo merging.                                                                                                                                                                                                                               |
| 14  | **Card page**                            | Parallel + intercepting routes (modal over board, full page on direct load), RHF + Zod form, 409 conflict view keeping typed input, comments with mentions, attachment upload with XHR progress straight to MinIO.                                                                                                                                                                                                                                                                                                   |
| 15  | **Search, settings, invite**             | `/search` (debounce, request cancellation, out-of-order protection, MSW race test), `/workspaces/[id]/settings` with Server Actions, `/invite/[token]`.                                                                                                                                                                                                                                                                                                                                                              |
| 16  | **E2E**                                  | Playwright in Docker (Chromium, Firefox, WebKit): invite via Mailpit API, two browsers moving cards, edit conflict, attachment upload/download, viewer restrictions, hydration-error fixture (fails any test that logs a hydration warning), presence timeout. Runs 3× in a row on one stack without restart.                                                                                                                                                                                                        |
| 17  | **CI**                                   | GitHub Actions on every push: lint, typecheck, unit/integration tests, image builds, compose-up e2e. Cache pnpm store.                                                                                                                                                                                                                                                                                                                                                                                               |
| 18  | **README and acceptance pass**           | Run and test instructions, order storage and concurrency, permission model, failure behavior, decisions, limitations (incl. WebKit ≠ Safari.app, with a short manual Safari checklist). Walk all 19 acceptance checks and note results.                                                                                                                                                                                                                                                                              |

---

## 4. Acceptance coverage

| #   | Check                                              | Covered in                                |
| --- | -------------------------------------------------- | ----------------------------------------- |
| 1   | `docker compose up --build`                        | 11, 18                                    |
| 2   | typecheck/lint/tests/CI                            | 1, 17                                     |
| 3   | Foreign ids → 404, search leaks                    | 6, 7, 8 tests                             |
| 4   | Viewer denied (PATCH, move, socket)                | 7, 9 tests, 16                            |
| 5   | Member removal kills socket                        | 9 test, 16                                |
| 6   | Two browsers × 50 moves converge                   | 7 test, 16                                |
| 7   | 10,000 moves between neighbors                     | 3, 7 tests                                |
| 8   | 409 and input preserved                            | 7 test, 14, 16                            |
| 9   | `.exe` as `.png`, 11 MB                            | 8 test, 16                                |
| 10  | URL expiry, unfinished upload cleanup              | 8, 10 tests                               |
| 11  | 5 mentions → one mail                              | 10 test                                   |
| 12  | Presence ≤ 10 s                                    | 9 test, 16                                |
| 13  | 1,000 cards smooth                                 | 13 (virtualization), manual profile in 18 |
| 14  | Spoofed XFF, NUL byte, socket flood                | 5, 9 tests                                |
| 15  | Restart PG/Redis, SIGTERM                          | 5, 10, manual in 11                       |
| 16  | `api` recreate without nginx restart               | 11 (DNS re-resolve), manual               |
| 17  | e2e ×3, Chrome/Firefox/WebKit, no hydration errors | 16, 17                                    |
| 18  | No internal URLs/secrets in client chunks          | 12 config, grep check in CI               |
| 19  | README matches behavior                            | 18                                        |

---

## 5. Risks to watch

- **Virtualization + dnd-kit** for a 1,000-card column (block 13). Fallback: windowing only above a threshold with the dragged item always mounted.
- **Presigned POST through nginx** needs the exact public host and path; verified in block 11 before building upload UI.
- **Safari**: Playwright WebKit approximates it; real Safari is a manual check (documented).
- **Zod 4 + Nest Swagger**: choose between `nestjs-zod` and a small custom pipe plus `zod-to-openapi` at block 5 after checking compatibility.
- **Next 15 + React 19 + Node 22** version combinations get pinned at block 12.
