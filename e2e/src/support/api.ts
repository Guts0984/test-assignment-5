import { request, type APIRequestContext } from '@playwright/test';

import { authFile, BASE_URL, type Role } from './env';
import { inviteTokenFor } from './mailpit';

export type Column = { id: string; name: string };

/** API access as one of the demo users, for arranging data quickly (the UI is what the tests check). */
export const apiAs = (role: Role): Promise<APIRequestContext> =>
  request.newContext({ baseURL: BASE_URL, storageState: authFile(role) });

export const json = async <T>(response: {
  ok(): boolean;
  status(): number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}): Promise<T> => {
  if (!response.ok())
    throw new Error(`API answered ${response.status()}: ${await response.text()}`);
  return (await response.json()) as T;
};

export const workspaceId = async (
  api: APIRequestContext,
  name = 'Acme Product',
): Promise<string> => {
  const all = await json<{ id: string; name: string }[]>(await api.get('/api/workspaces'));
  const found = all.find((w) => w.name === name);
  if (!found) throw new Error(`no workspace named ${name}`);
  return found.id;
};

export const uniqueName = (label: string): string =>
  `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A fresh board (default columns), so tests never depend on each other's leftovers. */
export const createBoard = async (
  api: APIRequestContext,
  label = 'e2e',
): Promise<{ id: string; name: string; columns: Column[] }> => {
  const name = uniqueName(label);
  const created = await json<{ id: string }>(
    await api.post(`/api/workspaces/${await workspaceId(api)}/boards`, { data: { name } }),
  );
  const board = await json<{ columns: Column[] }>(await api.get(`/api/boards/${created.id}`));
  return { id: created.id, name, columns: board.columns };
};

export const addCard = async (
  api: APIRequestContext,
  boardId: string,
  columnId: string,
  title: string,
  description = '',
): Promise<{ id: string }> =>
  json(await api.post(`/api/boards/${boardId}/cards`, { data: { columnId, title, description } }));

export const registerUser = async (
  label: string,
): Promise<{ email: string; handle: string; name: string; password: string }> => {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const user = {
    email: `${label}-${suffix}@example.com`,
    handle: `${label}${suffix}`.slice(0, 30),
    name: `E2E ${label}`,
    password: 'e2e-long-password-1',
  };
  const api = await request.newContext({ baseURL: BASE_URL });
  await json(await api.post('/api/auth/register', { data: user }));
  await api.dispose();
  return user;
};

/** A new account that is only a viewer in Acme Product (invited by alice and accepted through the API). */
export const registerViewerInAcme = async (
  label: string,
): Promise<{ email: string; password: string }> => {
  const user = await registerUser(label);
  const alice = await apiAs('alice');
  await json(
    await alice.post(`/api/workspaces/${await workspaceId(alice)}/invites`, {
      data: { email: user.email, role: 'viewer' },
    }),
  );
  const own = await request.newContext({ baseURL: BASE_URL });
  await json(await own.post('/api/auth/login', { data: user }));
  await json(await own.post(`/api/invites/${await inviteTokenFor(user.email)}/accept`));
  await own.dispose();
  await alice.dispose();
  return user;
};
