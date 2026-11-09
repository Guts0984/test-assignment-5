import type { MyInvite, WorkspaceSummary } from '@kanban/shared';
import Link from 'next/link';

import { NewBoardButton, NewWorkspaceButton, PendingInvites } from '@/features/workspaces';
import { loadPrivate } from '@/shared/lib/server-api';

export const metadata = { title: 'Your boards' };

export default async function HomePage() {
  const [workspaces, invites] = await Promise.all([
    loadPrivate<WorkspaceSummary[]>('/workspaces'),
    loadPrivate<MyInvite[]>('/me/invites'),
  ]);
  return (
    <main className="mx-auto grid max-w-3xl gap-6 p-6">
      <PendingInvites invites={invites} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Your workspaces</h1>
        <div className="flex flex-wrap gap-2">
          <NewWorkspaceButton />
          <NewBoardButton
            workspaces={workspaces
              .filter((workspace) => workspace.role !== 'viewer')
              .map(({ id, name }) => ({ id, name }))}
          />
        </div>
      </div>
      {workspaces.length === 0 ? (
        <p className="text-muted-foreground">
          You are not in any workspace yet. Create your own with “New workspace”, or accept an
          invitation from an owner.
        </p>
      ) : (
        workspaces.map((workspace) => (
          <section
            key={workspace.id}
            aria-labelledby={`ws-${workspace.id}`}
            className="grid gap-2 rounded-lg border border-border p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id={`ws-${workspace.id}`} className="text-lg font-semibold">
                {workspace.name}{' '}
                <span className="ml-2 rounded bg-muted px-2 py-0.5 text-xs font-normal">
                  {workspace.role}
                </span>
              </h2>
              <Link className="text-sm underline" href={`/workspaces/${workspace.id}/settings`}>
                Members and settings
              </Link>
            </div>
            <ul className="grid gap-1">
              {workspace.boards.map((board) => (
                <li key={board.id}>
                  <Link
                    className="underline-offset-4 hover:underline"
                    href={`/boards/${board.id}`}
                    prefetch={false}
                  >
                    {board.name}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}
