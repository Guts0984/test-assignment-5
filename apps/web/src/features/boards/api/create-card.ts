import type { BoardSnapshot, Card } from '@kanban/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api, describeError } from '@/shared/lib/client-api';
import { toast } from '@/shared/ui/toaster';
import { trackerFor } from '../model/event-tracker';
import { upsertCard } from '../model/board-cache';
import { boardKey } from './keys';

export const useCreateCard = (boardId: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ columnId, title }: { columnId: string; title: string }) =>
      api<Card>(`/boards/${boardId}/cards`, { json: { columnId, title } }),
    onSuccess: (card) => {
      void trackerFor(boardId); // the socket echo of this creation is harmless: same card id, same version
      client.setQueryData<BoardSnapshot>(boardKey(boardId), (current) =>
        current ? upsertCard(current, card) : current,
      );
    },
    onError: (error) => toast(`The card could not be created. ${describeError(error)}`, 'error'),
  });
};
