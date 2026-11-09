import type { BoardSnapshot, Card } from '@kanban/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { boardKey, upsertCard, removeCard } from '@/features/boards';
import { api } from '@/shared/lib/client-api';

/** Saves title / description. `version` is the one the editor started from; a stale one is a 409. */
export const useUpdateCard = (boardId: string, cardId: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { version: number; title: string; description: string }) =>
      api<Card>(`/cards/${cardId}`, { method: 'PATCH', json: input }),
    onSuccess: (card) =>
      client.setQueryData<BoardSnapshot>(boardKey(boardId), (current) =>
        current ? upsertCard(current, card) : current,
      ),
  });
};

export const useDeleteCard = (boardId: string, cardId: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api(`/cards/${cardId}`, { method: 'DELETE' }),
    onSuccess: () =>
      client.setQueryData<BoardSnapshot>(boardKey(boardId), (current) =>
        current ? removeCard(current, cardId) : current,
      ),
  });
};
