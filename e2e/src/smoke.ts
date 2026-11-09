import { readDotEnv } from '@kanban/env';
import { io } from 'socket.io-client';

/**
 * Checks the running stack through nginx, exactly as a browser would reach it: the only address
 * used is the public one. Run with `pnpm --filter @kanban/e2e smoke` after `docker compose up`.
 */
const env = readDotEnv();
const BASE = new URL(env.APP_ORIGIN ?? 'http://localhost:8080').origin;
const MAILPIT = 'http://localhost:8025';
const PASSWORD = env.SEED_PASSWORD ?? '';

// A 1x1 PNG, a Windows executable, and a file that claims to be bigger than the limit allows.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);
const EXE = Buffer.concat([
  Buffer.from('MZ'),
  Buffer.alloc(600, 0x90),
  Buffer.from('This program cannot be run in DOS mode.'),
]);

type Json = Record<string, unknown>;
const results: { name: string; ok: boolean; detail?: string }[] = [];

const check = async (name: string, run: () => Promise<void>): Promise<void> => {
  try {
    await run();
    results.push({ name, ok: true });
    console.log(`  ok    ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    console.log(`  FAIL  ${name}\n        ${detail}`);
  }
};

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const api = async (
  path: string,
  init: RequestInit & { json?: unknown; cookie?: string; headers?: Record<string, string> } = {},
) => {
  const { json, cookie, headers, ...rest } = init;
  const response = await fetch(`${BASE}/api${path}`, {
    ...rest,
    headers: {
      ...(json === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, body: body as Json, headers: response.headers };
};

const upload = (form: { url: string; fields: Record<string, string> }, bytes: Buffer) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(form.fields)) data.append(key, value);
  data.append('file', new Blob([new Uint8Array(bytes)]), 'upload');
  return fetch(form.url, { method: 'POST', body: data });
};

console.log(`Smoke test against ${BASE}\n`);

let cookie = '';
let boardId = '';
let columnId = '';

await check('nginx answers', async () => {
  const response = await fetch(`${BASE}/nginx-health`);
  assert(response.status === 200, `status ${response.status}`);
});

await check('both API instances are reachable through nginx and ready', async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 12; i += 1) {
    const response = await api('/ready');
    assert(response.status === 200, `ready: ${response.status} ${JSON.stringify(response.body)}`);
    seen.add(response.headers.get('x-request-id') ?? '');
  }
  assert(seen.size > 1, 'no responses');
});

await check('sign in as a seeded user (password from .env)', async () => {
  assert(PASSWORD, 'SEED_PASSWORD is not set in .env');
  const response = await api('/auth/login', {
    method: 'POST',
    json: { email: 'alice@example.com', password: PASSWORD },
  });
  assert(
    response.status === 200,
    `login: ${response.status} ${JSON.stringify(response.body)} (the limiter allows 10 sign-ins a minute: wait a minute and retry if you just ran this)`,
  );
  cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  assert(cookie.startsWith('sid='), 'no session cookie');
});

await check('the seeded board has 1,000 cards', async () => {
  const workspaces = (await api('/workspaces', { cookie })).body as unknown as {
    boards: { id: string; name: string }[];
  }[];
  const roadmap = workspaces.flatMap((w) => w.boards).find((b) => b.name === 'Roadmap');
  if (!roadmap) throw new Error('no Roadmap board');
  boardId = roadmap.id;
  const board = (await api(`/boards/${boardId}`, { cookie })).body as unknown as {
    cards: unknown[];
    columns: { id: string }[];
  };
  assert(board.cards.length >= 1000, `only ${board.cards.length} cards`);
  columnId = board.columns[0]?.id ?? '';
});

let cardId = '';
await check('create a card', async () => {
  const response = await api(`/boards/${boardId}/cards`, {
    method: 'POST',
    cookie,
    json: { columnId, title: `smoke ${Date.now()}` },
  });
  assert(response.status === 201, `${response.status} ${JSON.stringify(response.body)}`);
  cardId = String(response.body.id);
});

await check('upload a PNG through nginx, complete it, download the same bytes', async () => {
  const created = await api(`/cards/${cardId}/attachments`, {
    method: 'POST',
    cookie,
    json: { fileName: 'pixel.png', contentType: 'image/png', sizeBytes: PNG.length },
  });
  assert(created.status === 201, `register: ${created.status} ${JSON.stringify(created.body)}`);
  const form = created.body.upload as { url: string; fields: Record<string, string> };
  assert(form.url.startsWith(BASE), `upload address is ${form.url}, not the public one`);
  const stored = await upload(form, PNG);
  assert(stored.status < 300, `storage answered ${stored.status}: ${await stored.text()}`);

  const id = (created.body.attachment as { id: string }).id;
  const done = await api(`/attachments/${id}/complete`, { method: 'POST', cookie });
  assert(
    done.status === 200 && done.body.status === 'ready',
    `complete: ${done.status} ${JSON.stringify(done.body)}`,
  );

  const link = (await api(`/attachments/${id}/download`, { cookie })).body as { url: string };
  assert(link.url.startsWith(BASE), `download address is ${link.url}`);
  const file = await fetch(link.url);
  assert(file.status === 200, `download answered ${file.status}`);
  assert(Buffer.from(await file.arrayBuffer()).equals(PNG), 'downloaded bytes differ');
  assert(
    file.headers.get('content-type') === 'image/png',
    `content-type ${file.headers.get('content-type')}`,
  );
});

await check('an .exe renamed to .png is refused and removed', async () => {
  const created = await api(`/cards/${cardId}/attachments`, {
    method: 'POST',
    cookie,
    json: { fileName: 'holiday.png', contentType: 'image/png', sizeBytes: EXE.length },
  });
  const form = created.body.upload as { url: string; fields: Record<string, string> };
  assert(
    (await upload(form, EXE)).status < 300,
    'storage should accept it; only the content check can stop it',
  );
  const id = (created.body.attachment as { id: string }).id;
  const done = await api(`/attachments/${id}/complete`, { method: 'POST', cookie });
  assert(done.status === 415, `expected 415, got ${done.status}`);
  assert(
    (await api(`/attachments/${id}/download`, { cookie })).status === 404,
    'a refused file can still be downloaded',
  );
});

await check('a file declared larger than 11 MB is refused', async () => {
  const response = await api(`/cards/${cardId}/attachments`, {
    method: 'POST',
    cookie,
    json: { fileName: 'big.png', contentType: 'image/png', sizeBytes: 11 * 1024 * 1024 },
  });
  assert(response.status === 400, `expected 400, got ${response.status}`);
});

await check('live updates arrive over a real WebSocket through nginx', async () => {
  const socket = io(BASE, {
    transports: ['websocket'],
    extraHeaders: { cookie, origin: BASE },
    reconnection: false,
    forceNew: true,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    const joined = (await socket.timeout(5_000).emitWithAck('board.join', { boardId })) as {
      ok: boolean;
      snapshot?: { cards: unknown[] };
    };
    assert(
      joined.ok && (joined.snapshot?.cards.length ?? 0) >= 1000,
      `join: ${JSON.stringify(joined).slice(0, 200)}`,
    );

    const received = new Promise<string>((resolve) =>
      socket.once('card.created', (event: { card: { title: string } }) =>
        resolve(event.card.title),
      ),
    );
    const title = `live ${Date.now()}`;
    await api(`/boards/${boardId}/cards`, { method: 'POST', cookie, json: { columnId, title } });
    const got = await Promise.race([
      received,
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
    ]);
    assert(got === title, `expected "${title}", got "${got}"`);
  } finally {
    socket.disconnect();
  }
});

await check('Socket.IO does not offer the long-polling fallback', async () => {
  const response = await fetch(`${BASE}/socket.io/?EIO=4&transport=polling`);
  assert(response.status === 400, `status ${response.status}`);
});

await check('Swagger UI is served', async () => {
  const response = await fetch(`${BASE}/docs`);
  assert(
    response.status === 200 && (await response.text()).includes('swagger'),
    `status ${response.status}`,
  );
});

await check('Mailpit UI is reachable', async () => {
  const response = await fetch(`${MAILPIT}/api/v1/info`);
  assert(response.status === 200, `status ${response.status}`);
});

// ---- limits last, because they use up budgets -------------------------------------------------

await check(
  'faked X-Forwarded-For, X-Real-IP and signed-address headers do not escape the sign-in limit',
  async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 14; i += 1) {
      const response = await api('/auth/login', {
        method: 'POST',
        json: { email: 'nobody@example.com', password: 'wrong-password-1' },
        headers: {
          'x-forwarded-for': `203.0.113.${i + 1}`,
          'x-real-ip': `198.51.100.${i + 1}`,
          'x-client-ip': `192.0.2.${i + 1}`,
          'x-client-ip-signature': `${Date.now()}.${'0'.repeat(64)}`,
        },
      });
      statuses.push(response.status);
    }
    assert(statuses.includes(429), `never limited: ${statuses.join(',')}`);
    const limited = statuses.indexOf(429);
    assert(limited <= 10, `limit only kicked in at attempt ${limited + 1}: ${statuses.join(',')}`);
  },
);

await check('a burst of page requests is capped per visitor by nginx', async () => {
  const statuses = await Promise.all(
    Array.from({ length: 150 }, () => fetch(`${BASE}/`).then((r) => r.status)),
  );
  assert(statuses.includes(429), `no request was limited: ${[...new Set(statuses)].join(',')}`);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
