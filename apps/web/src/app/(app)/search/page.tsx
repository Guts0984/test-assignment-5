import type { WorkspaceSummary } from '@kanban/shared';

import { SearchView } from '@/features/search';
import { loadPrivate } from '@/shared/lib/server-api';

export const metadata = { title: 'Search' };

export default async function SearchPage() {
  const workspaces = await loadPrivate<WorkspaceSummary[]>('/workspaces');
  return (
    <main className="mx-auto grid max-w-3xl gap-4 p-6">
      <h1 className="text-2xl font-semibold">Search</h1>
      {workspaces.length === 0 ? (
        <p className="text-muted-foreground">You are not in any workspace yet.</p>
      ) : (
        <SearchView workspaces={workspaces.map(({ id, name }) => ({ id, name }))} />
      )}
    </main>
  );
}
