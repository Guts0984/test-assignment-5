import { mkdirSync } from 'node:fs';

import { request } from '@playwright/test';

import { ACCOUNTS, authFile, BASE_URL, PASSWORD, type Role } from './env';

/** Signs the three demo users in once and keeps their sessions, so tests do not spend the sign-in limit. */
export default async function globalSetup(): Promise<void> {
  if (!PASSWORD) throw new Error('SEED_PASSWORD is not set in .env');
  mkdirSync('.auth', { recursive: true });
  for (const role of Object.keys(ACCOUNTS) as Role[]) {
    const api = await request.newContext({ baseURL: BASE_URL });
    const response = await api.post('/api/auth/login', {
      data: { email: ACCOUNTS[role], password: PASSWORD },
    });
    if (!response.ok())
      throw new Error(`login as ${role} failed: ${response.status()} ${await response.text()}`);
    await api.storageState({ path: authFile(role) });
    await api.dispose();
  }
}
