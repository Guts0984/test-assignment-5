# Kanban board for teams

Workspaces with roles, boards with columns and cards, drag and drop, real-time collaboration,
comments with mentions, attachments and full-text search.

```
apps/api         NestJS REST + Socket.IO (runs as two instances behind nginx)
apps/worker      BullMQ: emails (invitations, mention digest) and cleanup
apps/web         Next.js 16 (App Router), React 19, TanStack Query, dnd-kit, Tailwind
packages/shared  Zod schemas and types shared by api, worker and web
packages/db      Drizzle schema, migrations, seed, ordering and card operations
packages/env     reads `.env` (the only place configuration files are read)
e2e              Playwright tests and a smoke script
infra/nginx      nginx configuration
```

`packages/db`, `packages/env` and `e2e` are additions to the four directories the assignment
names: the database code is needed by both `api` and `worker`, and reading `.env` in one place
keeps the rule "secrets live only in `.env`" enforceable.

## Run

Requirements: Docker with Compose. Nothing else.

```bash
cp .env.example .env
docker compose up --build
```

This is the only manual step. Migrations, the MinIO bucket and the demo data are created by
one-shot containers (`init`, `minio-setup`) and are safe to run again: nothing is duplicated.

| What                | Where                                   |
| ------------------- | --------------------------------------- |
| The application     | http://localhost:8080                   |
| Emails (Mailpit UI) | http://localhost:8025                   |
| API documentation   | http://localhost:8080/docs (Swagger UI) |

Only nginx (8080) and the Mailpit UI (8025) are published. File uploads and downloads go to
MinIO through nginx as well.

### Demo accounts

All four share the password from `SEED_PASSWORD` in your `.env` (the example file uses
`kanban-demo-password`).

| Login             | Acme Product | Beta Studio |
| ----------------- | ------------ | ----------- |
| alice@example.com | owner        | no access   |
| bob@example.com   | editor       | viewer      |
| carol@example.com | viewer       | no access   |
| dave@example.com  | no access    | owner       |

The seed creates 2 workspaces and 3 boards of 5 columns each. The board "Roadmap" has 1,000
cards. Anyone who registers can also create a workspace of their own and becomes its owner:
roles are per workspace.

Invitations are emailed (read them in Mailpit) and also appear inside the app for the invited
account, so they can be accepted without the email.

### Configuration

Every secret is in `.env` (template: `.env.example`). Secrets have **no defaults** anywhere in
the code; a service that lacks one refuses to start and names it. Public settings have
defaults. Optional knobs (all have defaults): `NGINX_PORT`, `MAILPIT_UI_PORT`,
`RATE_LIMIT_PER_MINUTE`, `AUTH_RATE_LIMIT_PER_MINUTE`, `PAGE_RATE_PER_SECOND` and
`API_RATE_PER_SECOND` (nginx, per visitor address), `DIGEST_MIN_INTERVAL_SECONDS`,
`DOWNLOAD_LINK_TTL_SECONDS`, `UPLOAD_MAX_AGE_SECONDS`.

### Without Docker (development)

Node 22+ and pnpm 12:

```bash
pnpm install
pnpm typecheck     # all packages, from the root, no build needed
pnpm lint
```

## Tests

```bash
pnpm test          # everything: prints one total at the end
```

The API, db and worker tests use real PostgreSQL, Redis, MinIO and Mailpit started by
Testcontainers, so Docker must be running. Web tests use Vitest and MSW. Test files live in a
`test/` directory of each package.

End-to-end tests (Playwright; Chromium, Firefox and WebKit as the Safari engine) run against a
started stack. Use the official image so all three browsers are available:

```bash
docker compose up --build -d
docker run --rm --network host --ipc=host -v "$PWD":/work -w /work \
  -e BASE_URL=http://localhost:8080 -e MAILPIT_URL=http://localhost:8025 \
  mcr.microsoft.com/playwright:v1.64.1-noble \
  bash -c "npm i -g pnpm@12.6.0 && pnpm install --frozen-lockfile --filter @kanban/e2e... && cd e2e && npx playwright test"
```

The suite creates its own boards, so it can be repeated on the same stack
(`--repeat-each=3`). All browsers share one IP address, so for e2e runs raise the per-address
limits in `.env`: `PAGE_RATE_PER_SECOND=300`, `API_RATE_PER_SECOND=900`,
`AUTH_RATE_LIMIT_PER_MINUTE=1000`, `RATE_LIMIT_PER_MINUTE=20000`. Do not run e2e against a stack
you care about: it creates data. `pnpm --filter @kanban/e2e smoke` is a quick 18-point check of
the main guarantees.

## How card order is stored

Each card has a `position` — a fractional index (a short string such as `a0`, `a0V`, `a1`)
stored with the `C` collation, so the database compares it byte by byte, exactly like the
client. Cards of a column are ordered by `(position, id)`.

- Moving one card computes one new key **between its new neighbours** and writes only that
  card. No other row changes.
- The move request names the neighbours (`afterId` / `beforeId`), not an index. If a neighbour
  was moved or deleted meanwhile, the server falls back to the remaining one (or the column's
  end), so the request never fails for that reason.
- Every move into a column takes a per-column PostgreSQL advisory lock for the length of the
  transaction. Concurrent moves therefore run one after another, and every client ends up with
  the same order, which is the database's order. Ties in keys are impossible to observe: the id
  is the tiebreaker.
- Repeated insertion between the same two neighbours makes keys longer. Past 64 characters the
  column is rebalanced (evenly spaced new keys, in the same transaction) and clients receive a
  `column.rebalanced` event. 10,000 moves between the same two neighbours are covered by a test.
- Realtime events carry the id of the activity-log row that produced them. Clients apply an
  event only if it is newer than what they already know about that card, so late, duplicated or
  reordered deliveries cannot move a card back, and a client's own change does not "jump" when
  its echo arrives.

Editing a card uses optimistic locking: `PATCH` carries the `version` the editor started from;
a mismatch answers `409` with the current card, and the UI shows it while keeping what the user
typed. Moving does not change the version.

## Permission model

Roles are per workspace: `owner`, `editor`, `viewer`. A user can be an owner of one workspace
and a viewer of another.

| Action                                            |       viewer       |   editor    | owner |
| ------------------------------------------------- | :----------------: | :---------: | :---: |
| Read boards, cards, comments, attachments, search |         ✔          |      ✔      |   ✔   |
| Create/edit/move/delete cards, comment, attach    |                    |      ✔      |   ✔   |
| Create boards in the workspace                    |                    |      ✔      |   ✔   |
| Rename/delete a board                             |                    | its creator |   ✔   |
| Invite people, change roles, remove members       |                    |             |   ✔   |
| Create a workspace of your own (you become owner) | any signed-in user |             |

Where it is enforced: one service, `WorkspaceAccessService`
(`apps/api/src/workspaces/workspace-access.service.ts`). Every endpoint resolves its target
(board, card, attachment, search workspace) to a workspace and asks that service.

- Not a member, or the thing does not exist: **404** (the two cases are indistinguishable, so ids
  cannot be probed). A member with too low a role: **403**.
- Membership is read from the database on every request, so removing a member or changing a role
  applies at once.
- Socket.IO: the connection is authenticated with the same session cookie, only members can
  join a board, and every message re-checks membership. A removal is also announced over Redis to
  both API instances, which close that user's board subscriptions immediately.
- The web UI hides what the server would refuse, but the server is the authority.

Other security measures: sessions live in Redis behind an `httpOnly` cookie; writes from other
origins are refused (Origin check); invite tokens are stored hashed; uploads are limited to
10 MB, images and PDF only, and the type is detected from the file content (not the name or the
declared type); download links are signed and expire after 5 minutes; secrets never reach the
client bundle.

## Rate limiting

Per end-user IP, counted in Redis so both API instances share it. The address is resolved as:
a signed claim from the Next.js server (HMAC with `CLIENT_IP_SECRET`, 60 s freshness) → the
`X-Real-IP` set by nginx (which overwrites anything the client sends) → the socket address.
`X-Forwarded-For` is never trusted. Every server-side call of the web app (`apiFetch` in
`apps/web/src/shared/lib/server-api.ts`) vouches for the visitor's address; without it all
visitors would share the web server's one address and one budget. Socket.IO connections and
messages are limited per address as well (all of a visitor's sockets together). nginx adds a
cheap per-address cap on pages and API calls in front of that.

## What happens when a dependency is down

| Down       | Behaviour                                                                                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL | No process exits. Requests that need it answer `503` in the standard error format; `/ready` reports it. Recovery is automatic once it is back.                                                                         |
| Redis      | No process exits. Sessions and realtime fan-out are unavailable until it returns; the rate limiter fails open (the API keeps serving instead of locking everyone out). Reconnects automatically.                       |
| MinIO      | Uploads and downloads fail (connection errors and timeouts are mapped to `503`, but this case has no dedicated test); everything else keeps working. Unfinished uploads are cleaned up by the worker after it returns. |

All calls have timeouts: PostgreSQL connect 3 s / statement 15 s, Redis 2 s, MinIO connect 2 s /
request 10 s, SMTP 5 s / 10 s. `GET /health` is liveness, `GET /ready` checks the three
dependencies. `SIGTERM` lets running requests finish and exits with code 0 in every service.

## Decisions and known limitations

Decisions where the assignment is open:

- **Board deletion is soft.** A deleted board and its cards disappear for everyone at once; the
  worker removes the files of its cards, the rows stay for history.
- **Anyone can create a workspace.** Not in the assignment's endpoint list; roles being per
  workspace, it does not conflict with "viewer only reads".
- **Invites grant `editor` or `viewer`**; owners are made by promoting a member.
- **Digest emails** collect mentions for a short window and are sent at most once per 15 minutes
  per user; emails go through an outbox table with a dedupe key, so a restart does not resend.
- **MinIO image:** the official MinIO images are no longer published, so the compose file uses
  the community image `pgsty/minio`. Swap the `image:` line if you have your own.
- **WebKit is the Safari stand-in** in e2e; it is the same engine but not Safari itself.

Known limitations:

- A crash in the narrow window between the SMTP server accepting a message and the row being
  marked as sent can send that one email twice.
- Mentions are highlighted but there is no autocomplete while typing `@`.
- No strict Content-Security-Policy (Next.js inline scripts would need nonces).
- Workspaces cannot be renamed or deleted from the application.
- The home page lists every board of a workspace without paging.
