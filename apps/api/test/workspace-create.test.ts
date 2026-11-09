import { workspaceMembers } from '@kanban/db';
import { createdBoardSchema, workspaceSummarySchema } from '@kanban/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  call,
  expectError as expectErrorCode,
  startApp,
  testConfig,
  type RunningApp,
} from './support/app';
import { as, asJson, makeWorkspace, registerUser, testDb, type TestUser } from './support/world';

const DEFAULT_CODE = {
  400: 'validation_failed',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
} as const;
const expectError = (
  response: { status: number; body: unknown },
  status: keyof typeof DEFAULT_CODE,
  code: (typeof DEFAULT_CODE)[keyof typeof DEFAULT_CODE] = DEFAULT_CODE[status],
) => expectErrorCode(response, status, code);

let api: RunningApp;
let viewerEverywhere: TestUser;
let someoneElse: TestUser;
let foreignWorkspaceId: string;

const url = (path: string) => `${api.url}${path}`;
const create = (user: TestUser, body: unknown) =>
  call(url('/workspaces'), asJson(user, 'POST', body));

beforeAll(async () => {
  api = await startApp(testConfig());
  [viewerEverywhere, someoneElse] = (await Promise.all(
    ['v', 's'].map((n) => registerUser(api.url, n)),
  )) as [TestUser, TestUser];
  // The user below is only a viewer in somebody else's workspace.
  foreignWorkspaceId = (
    await makeWorkspace([
      { user: someoneElse, role: 'owner' },
      { user: viewerEverywhere, role: 'viewer' },
    ])
  ).id;
});
afterAll(async () => {
  await api.close();
});

describe('creating a workspace', () => {
  it('works for a brand-new user with no workspace, who becomes its owner and can use it fully', async () => {
    const fresh = await registerUser(api.url, 'fresh');
    expect(((await call(url('/workspaces'), as(fresh))).body as unknown[]).length).toBe(0);

    const response = await create(fresh, { name: '  My team  ' });
    expect(response.status).toBe(201);
    const workspace = workspaceSummarySchema.parse(response.body);
    expect(workspace).toMatchObject({ name: 'My team', role: 'owner', boards: [] });

    const rows = await testDb()
      .db.select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspace.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: fresh.id, role: 'owner' });

    // owner of the new workspace: can make boards and invite people
    const board = await call(
      url(`/workspaces/${workspace.id}/boards`),
      asJson(fresh, 'POST', { name: 'First' }),
    );
    expect(createdBoardSchema.parse(board.body).name).toBe('First');
    const invite = await call(
      url(`/workspaces/${workspace.id}/invites`),
      asJson(fresh, 'POST', { email: 'friend@example.com', role: 'editor' }),
    );
    expect(invite.status).toBe(201);
  });

  it('works for someone who is only a viewer elsewhere, and does not change that role', async () => {
    const response = await create(viewerEverywhere, { name: 'Mine' });
    expect(response.status).toBe(201);
    const mine = workspaceSummarySchema.parse(response.body);

    const listed = (await call(url('/workspaces'), as(viewerEverywhere))).body as {
      id: string;
      role: string;
    }[];
    expect(listed.find((w) => w.id === mine.id)?.role).toBe('owner');
    expect(listed.find((w) => w.id === foreignWorkspaceId)?.role).toBe('viewer');

    // still read-only in the other workspace
    expectError(
      await call(
        url(`/workspaces/${foreignWorkspaceId}/boards`),
        asJson(viewerEverywhere, 'POST', { name: 'nope' }),
      ),
      403,
      'forbidden',
    );
  });

  it('keeps the new workspace private: nobody else can see or open it', async () => {
    const mine = workspaceSummarySchema.parse(
      (await create(viewerEverywhere, { name: 'Private' })).body,
    );
    const theirs = (await call(url('/workspaces'), as(someoneElse))).body as { id: string }[];
    expect(theirs.map((w) => w.id)).not.toContain(mine.id);
    expectError(
      await call(url(`/workspaces/${mine.id}/members`), as(someoneElse)),
      404,
      'not_found',
    );
    expectError(
      await call(
        url(`/workspaces/${mine.id}/boards`),
        asJson(someoneElse, 'POST', { name: 'intruder' }),
      ),
      404,
      'not_found',
    );
  });

  it('two workspaces with the same name are fine, each with its own owner', async () => {
    const a = workspaceSummarySchema.parse((await create(viewerEverywhere, { name: 'Same' })).body);
    const b = workspaceSummarySchema.parse((await create(someoneElse, { name: 'Same' })).body);
    expect(a.id).not.toBe(b.id);
  });

  it('needs a session', async () => {
    expectError(await call(url('/workspaces'), { method: 'POST', json: { name: 'x' } }), 401);
  });

  it.each([
    ['empty name', { name: '' }],
    ['blank name', { name: '   ' }],
    ['too long', { name: 'x'.repeat(101) }],
    ['NUL byte', { name: 'a\u0000b' }],
    ['not a string', { name: 5 }],
    ['missing', {}],
  ])('rejects %s with 400 and creates nothing', async (_label, body) => {
    const before = ((await call(url('/workspaces'), as(someoneElse))).body as unknown[]).length;
    expectError(await create(someoneElse, body), 400);
    expect(((await call(url('/workspaces'), as(someoneElse))).body as unknown[]).length).toBe(
      before,
    );
  });

  it('cannot be used to take a role in an existing workspace', async () => {
    // extra fields are ignored; the caller only ever becomes owner of the NEW workspace
    const response = await create(viewerEverywhere, { name: 'Sneaky', id: foreignWorkspaceId });
    const created = workspaceSummarySchema.parse(response.body);
    expect(created.id).not.toBe(foreignWorkspaceId);
    const members = await testDb()
      .db.select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, foreignWorkspaceId));
    expect(members.find((m) => m.userId === viewerEverywhere.id)?.role).toBe('viewer');
  });
});
