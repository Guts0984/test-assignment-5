import { readDotEnv } from '@kanban/env';

/** Where the stack is, and the demo password from the same .env the stack was started with. */
const env = readDotEnv();

export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
export const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';
export const PASSWORD = env.SEED_PASSWORD ?? '';

export const ACCOUNTS = {
  alice: 'alice@example.com', // owner of Acme Product
  bob: 'bob@example.com', // editor in Acme Product, viewer in Beta Studio
  carol: 'carol@example.com', // viewer in Acme Product
} as const;
export type Role = keyof typeof ACCOUNTS;

export const authFile = (role: Role) => `.auth/${role}.json`;
