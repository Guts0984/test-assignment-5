import { workspaceInvites, workspaceMembers } from '@kanban/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { call, startApp, testConfig, type RunningApp } from './support/app';
import { as, asJson, makeWorkspace, registerUser, testDb, type TestUser } from './support/world';

/**
 * Registration does not verify that the registrant owns the email address. So the address alone
 * must never be enough to get into a workspace: the emailed token is the only credential.
 */
let api: RunningApp;
let owner: TestUser;
let workspace: { id: string };

beforeAll(async () => {
  api = await startApp(testConfig());
  owner = await registerUser(api.url, 'owner');
  workspace = await makeWorkspace([{ user: owner, role: 'owner' }]);
});
afterAll(async () => {
  await api.close();
});

const url = (path: string) => `${api.url}${path}`;

/** Registers an account with an exact address, as an attacker who guessed the invited email would. */
const registerWithEmail = async (email: string): Promise<TestUser> => {
  const handle = `atk${Math.random().toString(36).slice(2, 12)}`;
  const response = await call(url('/auth/register'), {
    method: 'POST',
    json: { email, handle, name: 'Attacker', password: 'correct-horse-battery' },
  });
  if (response.status !== 201) throw new Error(`register failed: ${JSON.stringify(response.body)}`);
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  return { id: (response.body as { id: string }).id, email, handle, name: 'Attacker', cookie };
};

const isMember = async (userId: string): Promise<boolean> =>
  (
    await testDb()
      .db.select()
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, userId)),
      )
  ).length > 0;

const inviteFor = async (email: string): Promise<string> => {
  const invited = await call(
    url(`/workspaces/${workspace.id}/invites`),
    asJson(owner, 'POST', { email, role: 'editor' }),
  );
  expect(invited.status).toBe(201);
  return (invited.body as { id: string }).id;
};
const freshEmail = () => `newhire-${Math.random().toString(36).slice(2, 10)}@example.com`;

describe('an invitation cannot be taken over by registering the invited address', () => {
  it('does not let the registrant of the invited email accept it without the emailed token', async () => {
    const email = freshEmail();
    const inviteId = await inviteFor(email);
    const attacker = await registerWithEmail(email);

    const [row] = await testDb()
      .db.select({ id: workspaceInvites.id })
      .from(workspaceInvites)
      .where(eq(workspaceInvites.email, email));
    for (const id of new Set([row!.id, inviteId])) {
      const attempt = await call(url(`/me/invites/${id}/accept`), asJson(attacker, 'POST', {}));
      expect(attempt.status, `accepting ${id} without the token`).toBeGreaterThanOrEqual(400);
    }
    expect(await isMember(attacker.id)).toBe(false);
    const mine = (await call(url('/workspaces'), as(attacker))).body as { id: string }[];
    expect(mine.map((w) => w.id)).not.toContain(workspace.id);
  });

  it('does not show the invitation (workspace, inviter) to an account that has only claimed the address', async () => {
    const email = freshEmail();
    await inviteFor(email);
    const attacker = await registerWithEmail(email);
    const listing = await call(url('/me/invites'), as(attacker));
    if (listing.status === 200) expect(listing.body).toEqual([]);
    else expect(listing.status).toBe(404);
  });
});
