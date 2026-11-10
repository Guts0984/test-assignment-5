import { randomUUID } from 'node:crypto';

import { S3Client } from '@aws-sdk/client-s3';
import {
  comments,
  commentMentions,
  createDatabase,
  emailDeliveries,
  postgresUrl,
  users,
  workspaceMembers,
  type DatabaseHandle,
} from '@kanban/db';
import { and, eq } from 'drizzle-orm';
import { inject } from 'vitest';

import type { WorkerConfig } from '../../src/config';
import type { Deps } from '../../src/deps';
import { createMailer, type Mailer } from '../../src/mail/mailer';
import { createQueues } from '../../src/queues';
import { startWorker, type RunningWorker } from '../../src/worker';

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const waitFor = async (
  probe: () => Promise<boolean> | boolean,
  ms = 15_000,
  what = 'condition',
) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** Fast timings; the real defaults (60 s, 15 min, 1 h) are scaled down so tests run in seconds. */
export const testConfig = (overrides: Partial<WorkerConfig['timing']> = {}): WorkerConfig => {
  const infra = inject('infra');
  return {
    postgres: { ...infra.postgres },
    redis: { ...infra.redis },
    s3: {
      endpoint: infra.s3.endpoint,
      bucket: infra.s3.bucket,
      region: 'us-east-1',
      accessKey: infra.s3.accessKey,
      secretKey: infra.s3.secretKey,
    },
    smtp: { host: infra.smtp.host, port: infra.smtp.port, from: 'Kanban <no-reply@kanban.local>' },
    appOrigin: 'http://localhost:8080',
    healthPort: 0,
    queuePrefix: `kanban-test-${randomUUID()}`,
    timing: {
      scanIntervalMs: 200,
      cleanupIntervalMs: 300,
      digestCollectMs: 1_000,
      digestMinIntervalMs: 6_000,
      uploadMaxAgeMs: 60 * 60 * 1000,
      retryBackoffMs: 100,
      ...overrides,
    },
  };
};

let handle: DatabaseHandle | undefined;
export const testDb = (): DatabaseHandle => {
  handle ??= createDatabase({ url: postgresUrl(inject('infra').postgres), maxConnections: 10 });
  return handle;
};

export const testS3 = (): S3Client => {
  const s3 = inject('infra').s3;
  return new S3Client({
    region: 'us-east-1',
    endpoint: s3.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: s3.accessKey, secretAccessKey: s3.secretKey },
  });
};

export type Harness = {
  deps: Deps;
  /** Everything the jobs logged, in order. */
  logs: { message: string; extra: Record<string, unknown> }[];
  /** Starts a worker on the same queues (a second call = a second worker process). */
  start: (overrides?: Partial<Deps>) => Promise<RunningWorker>;
  stopAll: () => Promise<void>;
};

/** Dependencies wired to the real containers; any part can be replaced by a test. */
export const harness = (timing: Partial<WorkerConfig['timing']> = {}, mailer?: Mailer): Harness => {
  const config = testConfig(timing);
  const queues = createQueues(config);
  const logs: Harness['logs'] = [];
  const deps: Deps = {
    db: testDb().db,
    s3: testS3(),
    mailer: mailer ?? createMailer(config.smtp),
    config,
    queues,
    now: () => Date.now(),
    log: (message, extra = {}) => void logs.push({ message, extra }),
  };
  const running: RunningWorker[] = [];
  return {
    deps,
    logs,
    start: async (overrides = {}) => {
      // each worker gets its own Queue objects (as separate processes would), on the shared prefix
      const worker = await startWorker({ ...deps, queues: createQueues(config), ...overrides });
      running.push(worker);
      return worker;
    },
    stopAll: async () => {
      await Promise.allSettled(running.splice(0).map((worker) => worker.stop()));
      await Promise.allSettled(
        Object.values(queues).map((queue) =>
          queue.obliterate({ force: true }).then(() => queue.close()),
        ),
      );
    },
  };
};

// ---- Mailpit -----------------------------------------------------------------------------------

type MailpitMessage = { ID: string; Subject: string; To: { Address: string }[] };

export const mailTo = async (address: string): Promise<MailpitMessage[]> => {
  const response = await fetch(
    `${inject('infra').smtp.apiUrl}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}&limit=100`,
  );
  const body = (await response.json()) as { messages: MailpitMessage[] };
  return body.messages;
};

export const mailBody = async (
  id: string,
): Promise<{ text: string; html: string; messageId: string }> => {
  const response = await fetch(`${inject('infra').smtp.apiUrl}/api/v1/message/${id}`);
  const body = (await response.json()) as { Text: string; HTML: string; MessageID: string };
  return { text: body.Text, html: body.HTML, messageId: body.MessageID };
};

// ---- data --------------------------------------------------------------------------------------

export const uniqueEmail = (label: string) => `${label}-${randomUUID().slice(0, 8)}@example.com`;

export const queueInvite = async (toEmail: string, overrides: Record<string, unknown> = {}) => {
  const [row] = await testDb()
    .db.insert(emailDeliveries)
    .values({
      kind: 'invite',
      toEmail,
      dedupeKey: `invite:${randomUUID()}`,
      payload: {
        workspaceName: 'Acme',
        role: 'editor',
        invitedBy: 'Alice',
        link: 'http://localhost:8080/invite/secret-token-value',
        ...overrides,
      },
    })
    .returning();
  if (!row) throw new Error('insert failed');
  return row;
};

export const makeUser = async (label: string) => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const [user] = await testDb()
    .db.insert(users)
    .values({
      email: `${label}-${suffix}@example.com`,
      handle: `${label}${suffix}`,
      name: `Name ${label}`,
      passwordHash: 'x',
    })
    .returning();
  if (!user) throw new Error('user insert failed');
  return user;
};

/** Makes `user` an editor of the workspace (a no-op if they already are a member). */
export const join = async (workspaceId: string, user: { id: string }) => {
  await testDb()
    .db.insert(workspaceMembers)
    .values({ workspaceId, userId: user.id, role: 'editor' })
    .onConflictDoNothing();
};

/** What removing a member does in the api: their membership row is deleted. */
export const removeMember = async (workspaceId: string, user: { id: string }) => {
  await testDb()
    .db.delete(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, user.id)),
    );
};

/**
 * A comment by `author` on `cardId` that mentions each of `mentioned`. As in the api, only
 * workspace members can be mentioned, so the mentioned users are made members first.
 */
export const mention = async (
  fixture: { workspaceId: string },
  cardId: string,
  author: { id: string },
  mentioned: { id: string }[],
  body = 'please take a look',
) => {
  for (const person of mentioned) await join(fixture.workspaceId, person);
  const [comment] = await testDb()
    .db.insert(comments)
    .values({ workspaceId: fixture.workspaceId, cardId, authorId: author.id, body })
    .returning();
  if (!comment) throw new Error('comment insert failed');
  await testDb()
    .db.insert(commentMentions)
    .values(mentioned.map((person) => ({ commentId: comment.id, userId: person.id })));
  return comment;
};
