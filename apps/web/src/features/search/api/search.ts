import type { SearchPage } from '@kanban/shared';
import { useInfiniteQuery } from '@tanstack/react-query';

import { api } from '@/shared/lib/client-api';

export const searchKey = (workspaceId: string, q: string) => ['search', workspaceId, q] as const;

/**
 * One cache entry per (workspace, query). A late answer to an OLD query lands in that query's
 * own entry, so it can never replace the results of the current one; the request for a query the
 * user has already typed past is also aborted.
 */
export const useSearch = (workspaceId: string, q: string) =>
  useInfiniteQuery({
    queryKey: searchKey(workspaceId, q),
    enabled: q.length > 0 && workspaceId.length > 0,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api<SearchPage>(
        `/search?q=${encodeURIComponent(q)}&workspace=${workspaceId}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // While a new question is loading, keep showing the previous answer so the list does not
    // flash empty, but only for the same workspace: another workspace's results must never stay
    // on screen under a different workspace's name.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === workspaceId ? previous : undefined,
  });
