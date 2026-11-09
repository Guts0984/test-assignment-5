import type { BoardSnapshot } from '@kanban/shared';
import { useQuery } from '@tanstack/react-query';

import { api } from '@/shared/lib/client-api';
import { boardKey } from './keys';

/**
 * The server renders the board first and hands it over as initial data. The cache is then kept
 * current by realtime events (and replaced by the snapshot the server sends on every reconnect),
 * so it is never considered stale: there is nothing to refetch on a timer or on focus.
 */
export const useBoard = (boardId: string, initialData: BoardSnapshot) =>
  useQuery({
    queryKey: boardKey(boardId),
    queryFn: () => api<BoardSnapshot>(`/boards/${boardId}`),
    initialData,
    staleTime: Infinity,
  });
