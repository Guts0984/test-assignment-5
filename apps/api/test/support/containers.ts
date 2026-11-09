import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';

const run = promisify(execFile);

/** A port that is free right now; the container is bound to it so it survives a restart. */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

export type OwnPostgres = { container: StartedPostgreSqlContainer; port: number };
export type OwnRedis = { container: StartedRedisContainer; port: number; password: string };

/** A PostgreSQL we are free to stop and start without disturbing the shared one. */
export const startOwnPostgres = async (): Promise<OwnPostgres> => {
  const port = await freePort();
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withExposedPorts({ container: 5432, host: port })
    .start();
  return { container, port };
};

export const startOwnRedis = async (): Promise<OwnRedis> => {
  const port = await freePort();
  const password = 'own-redis-password';
  const container = await new RedisContainer('redis:7-alpine')
    .withPassword(password)
    .withExposedPorts({ container: 6379, host: port })
    .start();
  return { container, port, password };
};

/** `docker stop` / `docker start`: the same container comes back on the same port, as after a crash. */
export const stopContainer = (id: string) => run('docker', ['stop', '-t', '1', id]);
export const startContainer = (id: string) => run('docker', ['start', id]);
