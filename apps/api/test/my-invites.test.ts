import { workspaceInvites, workspaceMembers } from '@kanban/db';
import { myInviteSchema } from '@kanban/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { call, expectError, startApp, testConfig, type RunningApp } from './support/app';
import { as, asJson, makeWorkspace, registerUser, testDb, type TestUser } from './support/world';

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
const invite = (email: string, role = 'editor') =>
  call(url(`/workspaces/${workspace.id}/invites`), asJson(owner, 'POST', { email, role }));
const mine = async (user: TestUser) =>
  (await call(url('/me/invites'), as(user))).body as { id: string }[];

describe('invitations inside the app (without the emailed link)', () => {
  it('shows the signed-in user the open invitations sent to their own address, and lets them accept', async () => {
    const person = await registerUser(api.url, 'invitee');
    await invite(person.email, 'viewer');

    const list = (await mine(person)).map((i) => myInviteSchema.parse(i));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      workspaceId: workspace.id,
      role: 'viewer',
      invitedBy: owner.name,
    });

    const accepted = await call(
      url(`/me/invites/${list[0]!.id}/accept`),
      asJson(person, 'POST', {}),
    );
    expect(accepted).toMatchObject({
      status: 200,
      body: { workspaceId: workspace.id, role: 'viewer' },
    });
    expect(await mine(person)).toEqual([]);
    const workspaces = (await call(url('/workspaces'), as(person))).body as { id: string }[];
    expect(workspaces.map((w) => w.id)).toContain(workspace.id);
  });

  it('never shows or accepts somebody else’s invitation, and it looks like it does not exist', async () => {
    const target = await registerUser(api.url, 'target');
    const other = await registerUser(api.url, 'other');
    await invite(target.email);
    const [theirs] = await mine(target);

    expect(await mine(other)).toEqual([]);
    expectError(
      await call(url(`/me/invites/${theirs!.id}/accept`), asJson(other, 'POST', {})),
      404,
      'not_found',
    );
    expectError(
      await call(
        url('/me/invites/123e4567-e89b-42d3-a456-426614174999/accept'),
        asJson(other, 'POST', {}),
      ),
      404,
      'not_found',
    );
    const stillMember = await testDb()
      .db.select()
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, other.id)),
      );
    expect(stillMember).toEqual([]);
  });

  it('does not list expired, already accepted or replaced invitations', async () => {
    const person = await registerUser(api.url, 'stale');
    await invite(person.email);
    await testDb()
      .db.update(workspaceInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(workspaceInvites.email, person.email));
    expect(await mine(person)).toEqual([]);

    await invite(person.email, 'viewer'); // re-inviting replaces the old one with a fresh one
    const list = await mine(person);
    expect(list).toHaveLength(1);
    expect(
      (await call(url(`/me/invites/${list[0]!.id}/accept`), asJson(person, 'POST', {}))).status,
    ).toBe(200);
    expectError(
      await call(url(`/me/invites/${list[0]!.id}/accept`), asJson(person, 'POST', {})),
      404,
      'not_found',
    ); // used once
  });

  it('lets exactly one of several simultaneous accepts win', async () => {
    const person = await registerUser(api.url, 'racer');
    await invite(person.email);
    const [one] = await mine(person);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        call(url(`/me/invites/${one!.id}/accept`), asJson(person, 'POST', {})),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const rows = await testDb()
      .db.select()
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, person.id)),
      );
    expect(rows).toHaveLength(1);
  });

  it('needs a session, and rejects a malformed id', async () => {
    expectError(await call(url('/me/invites')), 401, 'unauthorized');
    expectError(
      await call(url('/me/invites/nope/accept'), { method: 'POST', ...as(owner) }),
      400,
      'validation_failed',
    );
  });
});
