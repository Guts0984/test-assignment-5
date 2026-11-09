import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything that can run queries: the root database or an open transaction. */
export type Executor = Database | Transaction;

export type DatabaseOptions = {
  url: string;
  applicationName?: string;
  maxConnections?: number;
  /** Max time to establish a connection (or wait for a free pooled one). */
  connectTimeoutMs?: number;
  /** Server-side limit for one statement; 0 disables (use for migrations). */
  statementTimeoutMs?: number;
  /** Server-side limit for a transaction sitting idle between statements. */
  idleInTransactionTimeoutMs?: number;
  /** Called for connection-level errors (e.g. PostgreSQL restarted). Must not throw. */
  onError?: (error: Error) => void;
};

export type DatabaseHandle = {
  db: Database;
  pool: pg.Pool;
  close: () => Promise<void>;
};

export type PostgresConnection = {
  user: string;
  password: string;
  database: string;
  host: string;
  port: number;
};

/** Connection string with credentials URL-encoded (passwords may contain `@`, `:` or `/`). */
export const postgresUrl = ({ user, password, database, host, port }: PostgresConnection): string =>
  `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;

const noop = (): void => undefined;

/**
 * Creates the pool and Drizzle instance.
 *
 * Connection errors must never crash the process: an idle client being killed by a
 * PostgreSQL restart emits `error` on the pool, and a checked-out client emits it on the
 * client itself. Without listeners Node treats both as uncaught exceptions. The pool simply
 * drops the broken client and the next query opens a fresh connection.
 */
export const createDatabase = (options: DatabaseOptions): DatabaseHandle => {
  const onError = options.onError ?? noop;

  const pool = new pg.Pool({
    connectionString: options.url,
    application_name: options.applicationName ?? 'kanban',
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: options.connectTimeoutMs ?? 5_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    query_timeout: (options.statementTimeoutMs ?? 15_000) + 5_000,
    idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs ?? 30_000,
  });

  pool.on('error', onError);
  pool.on('connect', (client) => {
    client.on('error', onError);
  });

  return { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
};
