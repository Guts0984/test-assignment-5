/**
 * One side of the stress test: run as `good` (a normal visitor) or `bad` (a flood), each from its
 * own container so that nginx sees two different visitor addresses. `e2e/stress/run.sh` starts
 * both at the same time and then checks what they could not see from the outside (Redis counters,
 * how the load was spread over the two API instances, CPU).
 *
 * Runs with plain Node (type stripping), so only erasable TypeScript is used here.
 */
import { io, type Socket } from 'socket.io-client';

const role = process.argv[2];
const TARGET = process.env.TARGET ?? 'http://nginx:8080'; // where to connect
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:8080'; // the site's public address (Origin check)
const EMAIL = process.env.EMAIL ?? '';
const PASSWORD = process.env.PASSWORD ?? '';
const SECONDS = Number(process.env.SECONDS_RUN ?? 30);

// The production limits, which the flood is expected to run into (see .env.example / compose).
const API_LIMIT_PER_MINUTE = Number(process.env.API_LIMIT_PER_MINUTE ?? 300);
const PAGE_RATE_PER_SECOND = Number(process.env.PAGE_RATE_PER_SECOND ?? 20);

type Reply = { status: number; ms: number; body: string };
const failures: string[] = [];
const expect = (condition: unknown, message: string): void => {
  if (!condition) failures.push(message);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const random = (n: number) => Math.floor(Math.random() * n);
const randomIp = () => `${1 + random(223)}.${random(256)}.${random(256)}.${1 + random(254)}`;

const call = async (path: string, init: RequestInit = {}): Promise<Reply> => {
  const started = performance.now();
  try {
    const response = await fetch(`${TARGET}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { origin: ORIGIN, ...(init.headers as Record<string, string> | undefined) },
    });
    const body = await response.text();
    return { status: response.status, ms: performance.now() - started, body };
  } catch {
    return { status: 0, ms: performance.now() - started, body: '' };
  }
};

const login = async (): Promise<string> => {
  const response = await fetch(`${TARGET}/api/auth/login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (response.status !== 200) throw new Error(`login failed: ${response.status}`);
  return (response.headers.getSetCookie()[0] ?? '').split(';')[0] ?? '';
};

type Workspace = { id: string; name: string; boards: { id: string; name: string }[] };
const findBoards = async (cookie: string) => {
  const reply = await call('/api/workspaces', { headers: { cookie } });
  const workspaces = JSON.parse(reply.body) as Workspace[];
  const acme = workspaces.find((workspace) => workspace.name === 'Acme Product');
  const roadmap = acme?.boards.find((board) => board.name === 'Roadmap');
  const sprint = acme?.boards.find((board) => board.name === 'Sprint Board');
  if (!acme || !roadmap || !sprint) throw new Error('the demo data is missing');
  return { workspaceId: acme.id, roadmapId: roadmap.id, sprintId: sprint.id };
};

const openSocket = (cookie: string, extra: Record<string, string> = {}): Socket =>
  io(TARGET, {
    transports: ['websocket'],
    extraHeaders: { cookie, origin: ORIGIN, ...extra },
    reconnection: false,
    forceNew: true,
  });

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};

/** A normal visitor: looks at pages, boards and search about once a second, adds a few cards. */
const good = async (): Promise<Record<string, unknown>> => {
  const cookie = await login();
  const { workspaceId, roadmapId, sprintId } = await findBoards(cookie);
  const headers = { cookie };

  const board = JSON.parse((await call(`/api/boards/${sprintId}`, { headers })).body) as {
    columns: { id: string }[];
  };
  const column = board.columns[0]?.id ?? '';

  const heard = new Set<string>();
  const socket = openSocket(cookie);
  socket.on('card.created', (event: { card?: { title?: string } }) => {
    if (event.card?.title) heard.add(event.card.title);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const joined = (await socket.timeout(8_000).emitWithAck('board.join', { boardId: sprintId })) as {
    ok: boolean;
  };
  expect(joined.ok, 'the good visitor could not join the board over the socket');
  let disconnected = false;
  socket.on('disconnect', () => (disconnected = true));
  const heartbeat = setInterval(
    () => socket.emit('presence.heartbeat', { boardId: sprintId }),
    2_000,
  );

  const timings: number[] = [];
  const statuses: Record<string, number> = {};
  const created: { id: string; title: string }[] = [];
  const record = (reply: Reply) => {
    timings.push(reply.ms);
    statuses[reply.status] = (statuses[reply.status] ?? 0) + 1;
    return reply;
  };

  const deadline = Date.now() + SECONDS * 1000;
  for (let tick = 0; Date.now() < deadline; tick += 1) {
    switch (tick % 6) {
      case 0:
        record(await call('/', { headers }));
        break;
      case 1:
        record(await call('/api/workspaces', { headers }));
        break;
      case 2:
        record(await call(`/api/boards/${tick % 12 === 2 ? roadmapId : sprintId}`, { headers }));
        break;
      case 3:
        record(await call(`/api/search?q=card&workspace=${workspaceId}`, { headers }));
        break;
      case 4: {
        const title = `stress ${Date.now().toString(36)}`;
        const reply = record(
          await call(`/api/boards/${sprintId}/cards`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ columnId: column, title }),
          }),
        );
        if (reply.status === 201)
          created.push({ id: (JSON.parse(reply.body) as { id: string }).id, title });
        break;
      }
      default:
        record(await call(`/boards/${sprintId}`, { headers }));
    }
    await sleep(600 + random(400)); // a person, not a script
  }

  await sleep(1_500); // the last card's event may still be on its way
  clearInterval(heartbeat);
  const missed = created.filter((card) => !heard.has(card.title));
  for (const card of created) await call(`/api/cards/${card.id}`, { method: 'DELETE', headers }); // leave the demo board as it was
  const wasDisconnected = disconnected; // before we hang up ourselves
  socket.disconnect();

  const blocked = (statuses[429] ?? 0) + (statuses[0] ?? 0);
  const serverErrors = Object.entries(statuses)
    .filter(([status]) => Number(status) >= 500)
    .reduce((sum, [, count]) => sum + count, 0);
  expect(blocked === 0, `the good visitor was refused ${blocked} times (429 or no answer)`);
  expect(serverErrors === 0, `the good visitor got ${serverErrors} server errors`);
  expect(created.length >= 3, `the good visitor managed to create only ${created.length} cards`);
  expect(
    missed.length === 0,
    `the socket did not deliver ${missed.length} of the visitor's own new cards`,
  );
  expect(!wasDisconnected, 'the good visitor was disconnected from the socket');
  expect(
    percentile(timings, 0.95) < 2_000,
    `the good visitor's p95 latency was ${Math.round(percentile(timings, 0.95))} ms`,
  );

  return {
    requests: timings.length,
    statuses,
    p50ms: Math.round(percentile(timings, 0.5)),
    p95ms: Math.round(percentile(timings, 0.95)),
    maxMs: Math.round(Math.max(...timings)),
    cardsCreated: created.length,
    cardsHeardOnSocket: created.length - missed.length,
  };
};

/** A malicious visitor: as many requests as the machine allows, with forged address headers. */
const bad = async (): Promise<Record<string, unknown>> => {
  const cookie = await login();
  const { workspaceId, roadmapId } = await findBoards(cookie);
  const deadline = Date.now() + SECONDS * 1000;

  const byKind: Record<string, Record<string, number>> = {};
  let sample429 = '';
  const note = (kind: string, reply: Reply) => {
    const bucket = (byKind[kind] ??= {});
    bucket[reply.status] = (bucket[reply.status] ?? 0) + 1;
    if (reply.status === 429 && !sample429) sample429 = reply.body;
  };

  const forged = () => ({
    cookie,
    'x-forwarded-for': randomIp(),
    'x-real-ip': randomIp(),
    'x-client-ip': randomIp(),
    'x-client-ip-signature': `${Date.now()}.deadbeef`,
  });

  const flood = async () => {
    while (Date.now() < deadline) {
      switch (random(6)) {
        case 0:
          note('api', await call('/api/workspaces', { headers: forged() }));
          break;
        case 1:
          note('api', await call(`/api/boards/${roadmapId}`, { headers: forged() }));
          break;
        case 2:
          note(
            'api',
            await call(`/api/search?q=card&workspace=${workspaceId}`, { headers: forged() }),
          );
          break;
        case 3:
          // an invalid write: costs the server a request, creates nothing
          note(
            'api',
            await call('/api/workspaces', {
              method: 'POST',
              headers: { ...forged(), 'content-type': 'application/json' },
              body: JSON.stringify({ name: '' }),
            }),
          );
          break;
        case 4:
          note('page', await call('/', { headers: forged() }));
          break;
        default:
          note(
            'signin',
            await call('/api/auth/login', {
              method: 'POST',
              headers: { ...forged(), 'content-type': 'application/json' },
              body: JSON.stringify({ email: EMAIL, password: 'wrong-password-on-purpose' }),
            }),
          );
      }
    }
  };

  // Sockets: many connections at once, and one that floods messages.
  const sockets: Socket[] = [];
  let connected = 0;
  let refused = 0;
  const openMany = async () => {
    await Promise.all(
      Array.from({ length: 150 }, async () => {
        const socket = openSocket(cookie, { 'x-forwarded-for': randomIp() });
        sockets.push(socket);
        await new Promise<void>((resolve) => {
          socket.once('connect', () => {
            connected += 1;
            resolve();
          });
          socket.once('connect_error', () => {
            refused += 1;
            resolve();
          });
          setTimeout(resolve, 5_000);
        });
      }),
    );
  };
  const floodSocket = async (): Promise<boolean> => {
    const first = sockets.find((socket) => socket.connected);
    if (!first) return true; // no connection could even be opened: nothing left to flood
    let dropped = false;
    first.on('disconnect', () => (dropped = true));
    for (let i = 0; i < 4_000 && !dropped; i += 1)
      first.emit('presence.heartbeat', { boardId: roadmapId });
    for (let waited = 0; waited < 10_000 && !dropped; waited += 100) await sleep(100);
    return dropped;
  };

  const sockets$ = openMany().then(floodSocket);
  await Promise.all([...Array.from({ length: 64 }, flood), sockets$]);
  const floodedSocketDropped = await sockets$;
  for (const socket of sockets) socket.disconnect();

  const total = (kinds: string[], accept: (status: number) => boolean) =>
    kinds.reduce(
      (sum, kind) =>
        sum +
        Object.entries(byKind[kind] ?? {})
          .filter(([status]) => accept(Number(status)))
          .reduce((inner, [, count]) => inner + count, 0),
      0,
    );
  const all = total(['api', 'page', 'signin'], () => true);
  const limited = total(['api', 'page', 'signin'], (status) => status === 429);
  const apiThrough = total(['api'], (status) => status !== 429 && status !== 0);
  const pageThrough = total(['page'], (status) => status !== 429 && status !== 0);
  const signinThrough = total(['signin'], (status) => status !== 429 && status !== 0);

  // Two fixed windows can both be used in one run, hence the factor 2.
  const apiBudget = 2 * API_LIMIT_PER_MINUTE;
  const pageBudget = 40 + PAGE_RATE_PER_SECOND * SECONDS + 40; // nginx: burst 40 plus the steady rate

  const serverErrors = total(['api', 'page', 'signin'], (status) => status >= 500);
  expect(
    serverErrors === 0,
    `${serverErrors} of the flood's requests were answered with a server error (a limited visitor must get 429, never 5xx)`,
  );
  expect(all >= 1_000, `the flood was too small to prove anything: ${all} requests`);
  expect(
    limited / all >= 0.7,
    `only ${Math.round((100 * limited) / all)}% of the flood was refused`,
  );
  expect(
    apiThrough <= apiBudget,
    `${apiThrough} API requests got through, the limit allows about ${API_LIMIT_PER_MINUTE} a minute`,
  );
  expect(
    pageThrough <= pageBudget,
    `${pageThrough} page requests got through, nginx allows about ${pageBudget}`,
  );
  expect(
    signinThrough <= 20,
    `${signinThrough} sign-in attempts got through (the limit is 10 a minute)`,
  );
  expect(
    sample429.includes('rate_limited'),
    `the refusal did not use the standard error format: ${sample429}`,
  );
  expect(
    refused > 0 || connected < 150,
    'not one of 150 simultaneous socket connections was refused',
  );
  expect(floodedSocketDropped, 'a socket that sent 4,000 messages in a burst was not cut off');

  return {
    requests: all,
    refused: limited,
    refusedPercent: Math.round((100 * limited) / all),
    gotThrough: { api: apiThrough, pages: pageThrough, signins: signinThrough },
    byKind,
    sockets: { attempted: 150, connected, refused },
    floodedSocketDropped,
  };
};

const main = async () => {
  if (role !== 'good' && role !== 'bad') throw new Error('usage: stress.ts good|bad');
  const summary = await (role === 'good' ? good() : bad());
  console.log(`RESULT ${role} ${JSON.stringify(summary)}`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`FAIL ${role}: ${failure}`);
    process.exit(1);
  }
  console.log(`PASS ${role}`);
  process.exit(0);
};

main().catch((error: unknown) => {
  console.log(`FAIL ${role}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
