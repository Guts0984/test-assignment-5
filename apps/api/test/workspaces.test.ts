import { emailDeliveries, workspaceInvites, workspaceMembers } from '@kanban/db';
import {
  invitePreviewSchema,
  inviteSchema,
  memberSchema,
  workspaceSummarySchema,
} from '@kanban/shared';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { call, expectError, startApp, testConfig, type RunningApp } from './support/app';
import { as, asJson, makeWorkspace, registerUser, testDb, type TestUser } from './support/world';
import { MEMBERSHIP_CHANNEL } from '../src/workspaces/membership-events';

let api: RunningApp;
let alice: TestUser; // owner of A
let bob: TestUser; // editor of A, viewer of B
let carol: TestUser; // viewer of A
let dave: TestUser; // owner of B
let eve: TestUser; // member of nothing
let A: { id: string; boardIds: string[] };
let B: { id: string; boardIds: string[] };

beforeAll(async () => {
  api = await startApp(testConfig());
  const everyone = await Promise.all(
    ['alice', 'bob', 'carol', 'dave', 'eve'].map((n) => registerUser(api.url, n)),
  );
  [alice, bob, carol, dave, eve] = everyone as [TestUser, TestUser, TestUser, TestUser, TestUser];
  A = await makeWorkspace(
    [
      { user: alice, role: 'owner' },
      { user: bob, role: 'editor' },
      { user: carol, role: 'viewer' },
    ],
    ['Roadmap', 'Sprint'],
  );
  B = await makeWorkspace(
    [
      { user: dave, role: 'owner' },
      { user: bob, role: 'viewer' },
    ],
    ['Marketing'],
  );
});

afterAll(async () => {
  await api.close();
});

const url = (path: string) => `${api.url}${path}`;
const NOT_FOUND_ID = '123e4567-e89b-42d3-a456-426614174999';

describe('GET /workspaces', () => {
  it('lists only my workspaces, with my role and the boards inside', async () => {
    const listFor = async (user: TestUser) =>
      (await call(url('/workspaces'), as(user))).body as {
        id: string;
        role: string;
        boards: { name: string }[];
      }[];

    const forBob = await listFor(bob);
    expect(forBob.map((w) => [w.id, w.role]).sort()).toEqual(
      [
        [A.id, 'editor'],
        [B.id, 'viewer'],
      ].sort(),
    );
    expect(forBob.find((w) => w.id === A.id)?.boards.map((b) => b.name)).toEqual([
      'Roadmap',
      'Sprint',
    ]);
    forBob.forEach((w) => workspaceSummarySchema.parse(w));

    expect((await listFor(alice)).map((w) => w.id)).toEqual([A.id]);
    expect((await listFor(dave)).map((w) => w.id)).toEqual([B.id]);
    expect(await listFor(eve)).toEqual([]);
  });

  it('needs a session', async () => {
    expectError(await call(url('/workspaces')), 401, 'unauthorized');
  });
});

describe('who may do what (roles x workspaces)', () => {
  // [who, workspace, endpoint, expected status]
  const members = (w: () => { id: string }) => `/workspaces/${w().id}/members`;
  const invite = (w: () => { id: string }) => `/workspaces/${w().id}/invites`;

  it.each([
    ['alice (owner)', () => alice, () => A, 200],
    ['bob (editor)', () => bob, () => A, 200],
    ['carol (viewer)', () => carol, () => A, 200],
    ['dave (owner of the other workspace)', () => dave, () => A, 404],
    ['eve (member of nothing)', () => eve, () => A, 404],
    ['bob (viewer)', () => bob, () => B, 200],
    ['alice (owner of the other workspace)', () => alice, () => B, 404],
  ])('listing members: %s', async (_who, user, workspace, status) => {
    const response = await call(url(members(workspace)), as(user()));
    expect(response.status).toBe(status);
    if (status === 200) (response.body as unknown[]).forEach((m) => memberSchema.parse(m));
  });

  it.each([
    ['alice (owner)', () => alice, () => A, 201],
    ['bob (editor)', () => bob, () => A, 403],
    ['carol (viewer)', () => carol, () => A, 403],
    ['bob (viewer of B)', () => bob, () => B, 403],
    ['dave (owner of B) on A', () => dave, () => A, 404],
    ['eve on A', () => eve, () => A, 404],
  ])('inviting: %s', async (_who, user, workspace, status) => {
    const email = `invitee-${Math.random().toString(36).slice(2, 10)}@example.com`;
    const response = await call(
      url(invite(workspace)),
      asJson(user(), 'POST', { email, role: 'viewer' }),
    );
    expect(response.status).toBe(status);
    if (status === 201) inviteSchema.parse(response.body);
  });

  it('a non-member cannot tell a real workspace from one that does not exist', async () => {
    const real = await call(url(members(() => A)), as(eve));
    const fake = await call(url(`/workspaces/${NOT_FOUND_ID}/members`), as(eve));
    expect(real.status).toBe(404);
    expect({ ...expectError(real, 404, 'not_found'), requestId: undefined }).toEqual({
      ...expectError(fake, 404, 'not_found'),
      requestId: undefined,
    });
  });

  it('malformed ids are a 400, not a server error', async () => {
    for (const bad of ['not-an-id', '%00', '1', "'; drop table users;--"]) {
      expectError(
        await call(url(`/workspaces/${encodeURIComponent(bad)}/members`), as(alice)),
        400,
        'validation_failed',
      );
    }
  });
});

describe('invitations', () => {
  const sendInvite = async (email: string, role = 'editor') =>
    call(url(`/workspaces/${A.id}/invites`), asJson(alice, 'POST', { email, role }));
  const tokenFor = async (email: string) => {
    const rows = await testDb()
      .db.select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.toEmail, email));
    const payload = rows.at(-1)?.payload as { link: string } | undefined;
    return { rows, token: payload?.link.split('/').pop() ?? '' };
  };

  it('are queued as an email in the outbox, and the response never contains the link', async () => {
    const email = `new-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const response = await sendInvite(email, 'editor');
    expect(response.status).toBe(201);
    expect(JSON.stringify(response.body)).not.toMatch(/token|invite\//i);

    const { rows, token } = await tokenFor(email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'invite', status: 'pending', toEmail: email });
    expect(rows[0]?.payload).toMatchObject({ role: 'editor', invitedBy: alice.name });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const stored = await testDb()
      .db.select()
      .from(workspaceInvites)
      .where(eq(workspaceInvites.email, email));
    expect(stored[0]?.tokenHash).not.toContain(token); // only a hash is kept
  });

  it('full flow: preview, wrong person refused, right person joins, link works once', async () => {
    const newcomer = await registerUser(api.url, 'newcomer');
    await sendInvite(newcomer.email, 'viewer');
    const { token } = await tokenFor(newcomer.email);

    const preview = await call(url(`/invites/${token}`)); // public: the link is the credential
    expect(invitePreviewSchema.parse(preview.body)).toMatchObject({
      email: newcomer.email,
      role: 'viewer',
    });

    expectError(
      await call(url(`/invites/${token}/accept`), asJson(eve, 'POST', {})),
      403,
      'forbidden',
    );
    expectError(
      await call(url(`/invites/${token}/accept`), { method: 'POST' }),
      401,
      'unauthorized',
    );
    expect((await call(url('/workspaces'), as(newcomer))).body).toEqual([]);

    const accepted = await call(url(`/invites/${token}/accept`), asJson(newcomer, 'POST', {}));
    expect(accepted).toMatchObject({ status: 200, body: { workspaceId: A.id, role: 'viewer' } });
    expect(
      ((await call(url('/workspaces'), as(newcomer))).body as { id: string }[]).map((w) => w.id),
    ).toEqual([A.id]);

    expectError(
      await call(url(`/invites/${token}/accept`), asJson(newcomer, 'POST', {})),
      404,
      'not_found',
    );
    expectError(await call(url(`/invites/${token}`)), 404, 'not_found');
  });

  it('unknown, malformed and expired links are all the same 404', async () => {
    const person = await registerUser(api.url, 'late');
    await sendInvite(person.email);
    const { token } = await tokenFor(person.email);
    await testDb()
      .db.update(workspaceInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(workspaceInvites.email, person.email));

    for (const t of [token, 'x'.repeat(43), 'short', '%00', 'a'.repeat(500)]) {
      expectError(await call(url(`/invites/${encodeURIComponent(t)}`)), 404, 'not_found');
      expectError(
        await call(url(`/invites/${encodeURIComponent(t)}/accept`), asJson(person, 'POST', {})),
        404,
        'not_found',
      );
    }
    expect((await call(url('/workspaces'), as(person))).body).toEqual([]);
  });

  it('inviting someone who is already a member is a conflict', async () => {
    expectError(await sendInvite(bob.email), 409, 'conflict');
    expectError(await sendInvite(bob.email.toUpperCase()), 409, 'conflict');
  });

  it('cannot hand out ownership, and rejects bad input', async () => {
    expectError(await sendInvite('x@example.com', 'owner'), 400, 'validation_failed');
    expectError(await sendInvite('not-an-email'), 400, 'validation_failed');
    expectError(
      await call(
        url(`/workspaces/${A.id}/invites`),
        asJson(alice, 'POST', { email: 'a\u0000b@example.com', role: 'viewer' }),
      ),
      400,
      'validation_failed',
    );
  });

  it('inviting the same address again replaces the link: the old one dies, a new mail is queued', async () => {
    const person = await registerUser(api.url, 'twice');
    await sendInvite(person.email, 'viewer');
    const first = await tokenFor(person.email);
    await sendInvite(person.email, 'editor');
    const second = await tokenFor(person.email);

    expect(second.rows).toHaveLength(2);
    expect(second.token).not.toBe(first.token);
    expectError(
      await call(url(`/invites/${first.token}/accept`), asJson(person, 'POST', {})),
      404,
      'not_found',
    );
    const accepted = await call(url(`/invites/${second.token}/accept`), asJson(person, 'POST', {}));
    expect(accepted.body).toMatchObject({ role: 'editor' }); // the newer invitation wins
    const open = await testDb()
      .db.select()
      .from(workspaceInvites)
      .where(and(eq(workspaceInvites.email, person.email), eq(workspaceInvites.workspaceId, A.id)));
    expect(open).toHaveLength(1);
  });

  it('two people racing to accept: exactly one wins, and there is one membership', async () => {
    const person = await registerUser(api.url, 'race');
    await sendInvite(person.email, 'viewer');
    const { token } = await tokenFor(person.email);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        call(url(`/invites/${token}/accept`), asJson(person, 'POST', {})),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 404)).toHaveLength(5);
    const rows = await testDb()
      .db.select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, A.id), eq(workspaceMembers.userId, person.id)));
    expect(rows).toHaveLength(1);
  });

  it('never demote someone who joins again through an invitation', async () => {
    // alice is an owner; an invitation to her own address would be refused before it got here
    expectError(await sendInvite(alice.email, 'viewer'), 409, 'conflict');
    const [row] = await testDb()
      .db.select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, A.id), eq(workspaceMembers.userId, alice.id)));
    expect(row?.role).toBe('owner');
  });
});

describe('changing and removing members', () => {
  const patch = (actor: TestUser, workspaceId: string, target: string, role: string) =>
    call(url(`/workspaces/${workspaceId}/members/${target}`), asJson(actor, 'PATCH', { role }));
  const remove = (actor: TestUser, workspaceId: string, target: string) =>
    call(url(`/workspaces/${workspaceId}/members/${target}`), { method: 'DELETE', ...as(actor) });
  const roleOf = async (workspaceId: string, userId: string) =>
    (
      await testDb()
        .db.select()
        .from(workspaceMembers)
        .where(
          and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
        )
    )[0]?.role;

  it.each([
    ['an editor', () => bob, 403],
    ['a viewer', () => carol, 403],
    ['a non-member', () => eve, 404],
    ['an owner of another workspace', () => dave, 404],
  ])('%s cannot change roles or remove anyone', async (_who, actor, status) => {
    const target = await registerUser(api.url, 'target');
    const W = await makeWorkspace([
      { user: alice, role: 'owner' },
      { user: bob, role: 'editor' },
      { user: carol, role: 'viewer' },
      { user: target, role: 'viewer' },
    ]);
    expect((await patch(actor(), W.id, target.id, 'owner')).status).toBe(status);
    expect((await remove(actor(), W.id, target.id)).status).toBe(status);
    expect(await roleOf(W.id, target.id)).toBe('viewer'); // untouched
  });

  it('an owner promotes, demotes and removes; a removed member loses access on their very next request', async () => {
    const member = await registerUser(api.url, 'leaver');
    const W = await makeWorkspace(
      [
        { user: alice, role: 'owner' },
        { user: member, role: 'viewer' },
      ],
      ['Board'],
    );
    expect((await call(url(`/workspaces/${W.id}/members`), as(member))).status).toBe(200);

    expect(await patch(alice, W.id, member.id, 'editor')).toMatchObject({
      status: 200,
      body: { role: 'editor' },
    });
    expect(await roleOf(W.id, member.id)).toBe('editor');

    expect((await remove(alice, W.id, member.id)).status).toBe(204);
    // the same still-valid session, but access to the workspace is gone at once
    expectError(await call(url(`/workspaces/${W.id}/members`), as(member)), 404, 'not_found');
    expect((await call(url('/workspaces'), as(member))).body).toEqual([]);
    expect((await call(url('/me'), as(member))).status).toBe(200); // the account itself is fine
    expectError(await remove(alice, W.id, member.id), 404, 'not_found'); // already gone
  });

  it('a workspace always keeps an owner, also when two owners act at the same moment', async () => {
    const second = await registerUser(api.url, 'coowner');
    const lone = await makeWorkspace([{ user: alice, role: 'owner' }]);
    expectError(await patch(alice, lone.id, alice.id, 'viewer'), 409, 'conflict');
    expectError(await remove(alice, lone.id, alice.id), 409, 'conflict');
    expect((await patch(alice, lone.id, alice.id, 'owner')).status).toBe(200); // a no-op is fine

    for (let round = 0; round < 8; round += 1) {
      const W = await makeWorkspace([
        { user: alice, role: 'owner' },
        { user: second, role: 'owner' },
      ]);
      const outcomes = await Promise.all([
        patch(alice, W.id, second.id, 'viewer'),
        patch(second, W.id, alice.id, 'viewer'),
      ]);
      const owners = (
        await testDb()
          .db.select()
          .from(workspaceMembers)
          .where(and(eq(workspaceMembers.workspaceId, W.id), eq(workspaceMembers.role, 'owner')))
      ).length;
      expect(owners, `round ${round}: ${outcomes.map((o) => o.status).join(',')}`).toBe(1);
      expect(outcomes.map((o) => o.status).sort()).toEqual([200, 403]); // the loser is no longer an owner
    }
  });

  it('announces removals and role changes so open sockets can be closed at once', async () => {
    const { host, port, password } = inject('infra').redis;
    const listener = new Redis({ host, port, password });
    const seen: unknown[] = [];
    await listener.subscribe(MEMBERSHIP_CHANNEL);
    listener.on('message', (_channel, message) => seen.push(JSON.parse(message)));

    const member = await registerUser(api.url, 'watched');
    const W = await makeWorkspace([
      { user: alice, role: 'owner' },
      { user: member, role: 'editor' },
    ]);
    await patch(alice, W.id, member.id, 'viewer');
    await remove(alice, W.id, member.id);
    await new Promise((r) => setTimeout(r, 300));
    listener.disconnect();

    expect(seen).toEqual([
      { type: 'role_changed', workspaceId: W.id, userId: member.id, role: 'viewer' },
      { type: 'removed', workspaceId: W.id, userId: member.id },
    ]);
  });

  it('refuses unknown roles and unknown targets', async () => {
    const W = await makeWorkspace([{ user: alice, role: 'owner' }]);
    expectError(await patch(alice, W.id, bob.id, 'owner'), 404, 'not_found'); // bob is not in W
    expectError(await patch(alice, W.id, alice.id, 'superuser'), 400, 'validation_failed');
    expectError(await patch(alice, W.id, 'nope', 'viewer'), 400, 'validation_failed');
  });
});
