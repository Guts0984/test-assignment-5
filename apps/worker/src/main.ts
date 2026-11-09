import { createServer } from 'node:http';

import { S3Client } from '@aws-sdk/client-s3';
import { createDatabase, postgresUrl } from '@kanban/db';

import { config } from './env';
import { createMailer } from './mail/mailer';
import { createQueues } from './queues';
import { startWorker } from './worker';

const log = (message: string, extra: Record<string, unknown> = {}): void => {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level: 'info',
      context: 'Worker',
      message,
      ...extra,
    }),
  );
};
const logError = (message: string, extra: Record<string, unknown> = {}): void => {
  console.error(
    JSON.stringify({
      time: new Date().toISOString(),
      level: 'error',
      context: 'Worker',
      message,
      ...extra,
    }),
  );
};

// A dropped promise must not take the process down; it is logged instead.
process.on('unhandledRejection', (reason) =>
  logError('unhandled rejection', { reason: String(reason) }),
);
process.on('uncaughtException', (error) => {
  logError('uncaught exception', { error: error.message });
  process.exit(1);
});

const { db, close: closeDb } = createDatabase({
  url: postgresUrl(config.postgres),
  applicationName: 'kanban-worker',
  maxConnections: 10,
  connectTimeoutMs: 3_000,
  statementTimeoutMs: 15_000,
  onError: (error) => logError('postgres connection error', { error: error.message }),
});

const s3 = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secretKey },
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 2_000, requestTimeout: 10_000 },
});

const running = await startWorker({
  db,
  s3,
  mailer: createMailer(config.smtp),
  config,
  queues: createQueues(config),
  now: () => Date.now(),
  log,
});

// Liveness for the container healthcheck: the process is up and its event loop is running.
const health = createServer((request, response) => {
  response.writeHead(request.url === '/health' ? 200 : 404, { 'content-type': 'text/plain' });
  response.end(request.url === '/health' ? 'ok' : 'not found');
});
health.listen(config.healthPort, '0.0.0.0');
log('worker started');

let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  log(`${signal} received, finishing running jobs`);
  const timer = setTimeout(() => {
    logError('shutdown timed out');
    process.exit(1);
  }, 25_000);
  try {
    health.close();
    await running.stop();
    await closeDb();
    s3.destroy();
    log('shutdown complete');
    clearTimeout(timer);
    process.exit(0);
  } catch (error) {
    logError('shutdown failed', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
