import type { BoardSnapshot, MoveCardResponse } from '@kanban/shared';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api, describeError } from '@/shared/lib/client-api';
import { toast } from '@/shared/ui/toaster';
import { applyEvent, applyMove, placeCard } from '../model/board-cache';
import { trackerFor } from '../model/event-tracker';
import {
  beginMove,
  confirmedPlace,
  confirmMove,
  endMove,
  hasLaterMove,
} from '../model/pending-moves';
import { cardsOfColumn, optimisticKey, type DropTarget } from '../model/order';
import { boardKey } from './keys';

export type MoveVariables = { cardId: string; target: DropTarget };

/**
 * Moves for the same card run one after another: a quick second drag must not overtake the first
 * (the server applies them in arrival order, and the second is relative to the first's result).
 */
const chains = new Map<string, Promise<unknown>>();
const inOrder = <T>(cardId: string, task: () => Promise<T>): Promise<T> => {
  const next = (chains.get(cardId) ?? Promise.resolve()).catch(() => undefined).then(task);
  chains.set(cardId, next);
  void next
    .finally(() => chains.get(cardId) === next && chains.delete(cardId))
    .catch(() => undefined);
  return next;
};

const newMutationId = (): string => `m-${crypto.randomUUID()}`;

const neighbourKeys = (snapshot: BoardSnapshot, cardId: string, target: DropTarget) => {
  const others = cardsOfColumn(snapshot, target.columnId).filter((card) => card.id !== cardId);
  return {
    before: others[target.index - 1]?.position ?? null,
    after: others[target.index]?.position ?? null,
  };
};

export const moveCardRequest = (
  cardId: string,
  target: DropTarget,
  clientMutationId: string,
): Promise<MoveCardResponse> =>
  api<MoveCardResponse>(`/cards/${cardId}/move`, {
    json: {
      columnId: target.columnId,
      afterId: target.afterId,
      beforeId: target.beforeId,
      clientMutationId,
    },
  });

/** Applies the server's answer to the cache, unless a newer change of that card was already seen. */
export const applyMoveResponse = (
  client: QueryClient,
  boardId: string,
  response: MoveCardResponse,
): void => {
  client.setQueryData<BoardSnapshot>(boardKey(boardId), (current) =>
    current ? applyMove(current, response.card, response.eventId, trackerFor(boardId)) : current,
  );
};

/**
 * Optimistic move. The card jumps to its new place at once; if the server refuses, only THAT
 * card goes back (other people's concurrent changes stay) and the reason is shown. The answer is
 * applied through the same guard as the socket echo, so whichever arrives first, the card does not
 * move twice.
 */
export const useMoveCard = (boardId: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ['move-card', boardId],
    mutationFn: ({ cardId, target }: MoveVariables) =>
      inOrder(cardId, () => moveCardRequest(cardId, target, newMutationId())),
    onMutate: async ({ cardId, target }) => {
      await client.cancelQueries({ queryKey: boardKey(boardId) });
      const before = client.getQueryData<BoardSnapshot>(boardKey(boardId));
      const card = before?.cards.find((candidate) => candidate.id === cardId);
      if (!before || !card) return undefined;
      const { before: prev, after: next } = neighbourKeys(before, cardId, target);
      const position = optimisticKey(prev, next);
      beginMove(cardId, { columnId: card.columnId, position: card.position });
      client.setQueryData<BoardSnapshot>(
        boardKey(boardId),
        placeCard(before, cardId, { columnId: target.columnId, position }),
      );
      return { optimistic: { columnId: target.columnId, position } };
    },
    onSuccess: (response, { cardId }, context) => {
      if (!context) return applyMoveResponse(client, boardId, response);
      confirmMove(cardId, { columnId: response.card.columnId, position: response.card.position });
      // A later move of this card is already shown: this answer is outdated for the screen (the
      // last answer of the series will place the card), and applying it would make the card jump.
      if (!hasLaterMove(cardId)) applyMoveResponse(client, boardId, response);
    },
    onError: (error, { cardId }, context) => {
      const confirmed = confirmedPlace(cardId);
      if (context && confirmed) {
        client.setQueryData<BoardSnapshot>(boardKey(boardId), (current) => {
          const card = current?.cards.find((candidate) => candidate.id === cardId);
          // Only undo our own guess: if something else has moved the card since, leave it.
          return current &&
            card &&
            card.columnId === context.optimistic.columnId &&
            card.position === context.optimistic.position
            ? placeCard(current, cardId, confirmed)
            : current;
        });
      }
      toast(`The card could not be moved. ${describeError(error)}`, 'error');
    },
    onSettled: (_response, _error, { cardId }, context) => {
      if (!context) return;
      const announcement = endMove(cardId);
      if (announcement)
        client.setQueryData<BoardSnapshot>(boardKey(boardId), (current) =>
          current ? applyEvent(current, 'card.moved', announcement, trackerFor(boardId)) : current,
        );
    },
  });
};
