import type { Member, Me, WorkspaceSummary } from '@kanban/shared';
import Link from 'next/link';

import { MembersPanel } from '@/features/workspaces';
import { loadPrivate } from '@/shared/lib/server-api';

export const metadata = { title: 'Workspace settings' };

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [members, workspaces, me] = await Promise.all([
    loadPrivate<Member[]>(`/workspaces/${id}/members`),
    loadPrivate<WorkspaceSummary[]>('/workspaces'),
    loadPrivate<Me>('/me'),
  ]);
  const workspace = workspaces.find((candidate) => candidate.id === id);
  return (
    <main className="mx-auto grid max-w-3xl gap-6 p-6">
      <div>
        <Link prefetch={false} href="/" className="text-sm underline">
          ← Your workspaces
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{workspace?.name ?? 'Workspace'} · members</h1>
      </div>
      <MembersPanel
        members={members}
        workspaceId={id}
        role={workspace?.role ?? 'viewer'}
        currentUserId={me.id}
      />
    </main>
  );
}
