import type { BoardSnapshot, MoveCardResponse } from '@kanban/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { boardKey } from '@/features/boards/api/keys';
import { useMoveCard } from '@/features/boards/api/move-card';
import { applyEvent } from '@/features/boards/model/board-cache';
import { trackerFor } from '@/features/boards/model/event-tracker';
import { deferAnnouncement } from '@/features/boards/model/pending-moves';
import { cardsOfColumn, type DropTarget } from '@/features/boards/model/order';
import { toast } from '@/shared/ui/toaster';
import { board, card, cardId, ids } from './support/fixtures';
import { server } from './support/msw';

vi.mock('@/shared/ui/toaster', () => ({ toast: vi.fn() }));

const setup = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(boardKey(ids.board), board());
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useMoveCard(ids.board), { wrapper });
  const snapshot = () => client.getQueryData<BoardSnapshot>(boardKey(ids.board))!;
  const positionOf = (n: number) => snapshot().cards.find((c) => c.id === cardId(n))!;
  return { client, hook, snapshot, positionOf };
};

// Card 3 goes between Card 1 and Card 2.
const between: DropTarget = {
  columnId: ids.todo,
  index: 1,
  afterId: cardId(1),
  beforeId: cardId(2),
};
const response = (
  n: number,
  position: string,
  eventId: number,
  columnId = ids.todo,
): MoveCardResponse => ({
  card: card(n, { position, columnId }),
  eventId,
  fromColumnId: ids.todo,
  rebalanced: false,
});
const forbidden = () =>
  HttpResponse.json(
    { error: { code: 'forbidden', message: 'You do not have permission to do this' } },
    { status: 403 },
  );

beforeEach(() => {
  trackerFor(ids.board).reset(0);
  vi.mocked(toast).mockClear();
});

describe('moving a card', () => {
  it('shows the card in its new place at once, then settles on the position the server chose', async () => {
    server.use(
      http.post('http://localhost/api/cards/:id/move', async () => {
        await delay(80);
        return HttpResponse.json(response(3, 'a15', 4));
      }),
    );
    const { hook, snapshot, positionOf } = setup();

    act(() => hook.result.current.mutate({ cardId: cardId(3), target: between }));
    await waitFor(() =>
      expect(cardsOfColumn(snapshot(), ids.todo).map((c) => c.title)).toEqual([
        'Card 1',
        'Card 3',
        'Card 2',
      ]),
    ); // optimistic: before the server answered
    expect(hook.result.current.isPending).toBe(true);

    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(positionOf(3).position).toBe('a15'); // the server's key replaced our guess
  });

  it('puts the card back and explains why when the server refuses', async () => {
    server.use(http.post('http://localhost/api/cards/:id/move', forbidden));
    const { hook, snapshot, positionOf } = setup();
    const original = positionOf(3).position;

    act(() => hook.result.current.mutate({ cardId: cardId(3), target: between }));
    await waitFor(() => expect(hook.result.current.isError).toBe(true));

    expect(positionOf(3)).toMatchObject({ position: original, columnId: ids.todo });
    expect(cardsOfColumn(snapshot(), ids.todo).map((c) => c.title)).toEqual([
      'Card 1',
      'Card 2',
      'Card 3',
    ]);
    expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/could not be moved.*permission/i),
      'error',
    );
  });

  it('undoes only the failed card: other people’s changes made meanwhile stay', async () => {
    server.use(
      http.post('http://localhost/api/cards/:id/move', async () => {
        await delay(80);
        return forbidden();
      }),
    );
    const { client, hook, positionOf } = setup();

    act(() => hook.result.current.mutate({ cardId: cardId(3), target: between }));
    await waitFor(() => expect(hook.result.current.isPending).toBe(true));
    // meanwhile somebody else moves Card 2 to the "doing" column
    client.setQueryData<BoardSnapshot>(boardKey(ids.board), (current) =>
      applyEvent(
        current!,
        'card.moved',
        {
          eventId: 9,
          boardId: ids.board,
          actorId: null,
          clientMutationId: null,
          card: card(2, { columnId: ids.doing, position: 'a9' }),
          fromColumnId: ids.todo,
        },
        trackerFor(ids.board),
      ),
    );
    await waitFor(() => expect(hook.result.current.isError).toBe(true));

    expect(positionOf(3).position).toBe('a3'); // ours: back
    expect(positionOf(2)).toMatchObject({ columnId: ids.doing, position: 'a9' }); // theirs: kept
  });

  it('does not undo somebody else’s move of the SAME card when our own move is refused', async () => {
    server.use(
      http.post('http://localhost/api/cards/:id/move', async () => {
        await delay(80);
        return forbidden();
      }),
    );
    const { client, hook, positionOf } = setup();

    act(() => hook.result.current.mutate({ cardId: cardId(3), target: between }));
    await waitFor(() => expect(hook.result.current.isPending).toBe(true));
    // while ours is in flight, another user puts the same card into "doing"
    client.setQueryData<BoardSnapshot>(boardKey(ids.board), (current) =>
      applyEvent(
        current!,
        'card.moved',
        {
          eventId: 9,
          boardId: ids.board,
          actorId: null,
          clientMutationId: null,
          card: card(3, { columnId: ids.doing, position: 'a9' }),
          fromColumnId: ids.todo,
        },
        trackerFor(ids.board),
      ),
    );
    await waitFor(() => expect(hook.result.current.isError).toBe(true));

    expect(positionOf(3)).toMatchObject({ columnId: ids.doing, position: 'a9' }); // theirs stays; ours is not "restored" over it
  });

  it('does not make the card jump when the socket echo of the same move arrives (before or after the answer)', async () => {
    for (const echoFirst of [true, false]) {
      trackerFor(ids.board).reset(0);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      server.use(
        http.post('http://localhost/api/cards/:id/move', async () => {
          await gate;
          return HttpResponse.json(response(3, 'a15', 4));
        }),
      );
      const { client, hook, positionOf } = setup();
      const seen: string[] = [positionOf(3).position]; // where it starts
      client.getQueryCache().subscribe(() => {
        const position = client
          .getQueryData<BoardSnapshot>(boardKey(ids.board))
          ?.cards.find((c) => c.id === cardId(3))?.position;
        if (position && seen.at(-1) !== position) seen.push(position);
      });
      const echo = () =>
        client.setQueryData<BoardSnapshot>(boardKey(ids.board), (current) =>
          applyEvent(
            current!,
            'card.moved',
            {
              eventId: 4,
              boardId: ids.board,
              actorId: null,
              clientMutationId: 'm-1',
              card: card(3, { position: 'a15' }),
              fromColumnId: ids.todo,
            },
            trackerFor(ids.board),
          ),
        );

      act(() => hook.result.current.mutate({ cardId: cardId(3), target: between }));
      await waitFor(() => expect(hook.result.current.isPending).toBe(true));
      if (echoFirst) echo();
      release();
      await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
      if (!echoFirst) echo();

      expect(positionOf(3).position).toBe('a15');
      // a3 (before) -> our guess -> a15 (final), and never back to an earlier value
      expect(seen[0]).toBe('a3');
      expect(seen.at(-1)).toBe('a15');
      expect(seen.filter((p) => p === 'a15')).toHaveLength(1);
      expect(new Set(seen).size).toBe(seen.length);
    }
  });

  it('sends quick successive moves of one card one after another, never overlapping', async () => {
    let running = 0;
    let overlapped = false;
    const bodies: unknown[] = [];
    server.use(
      http.post('http://localhost/api/cards/:id/move', async ({ request }) => {
        running += 1;
        overlapped ||= running > 1;
        bodies.push(await request.json());
        await delay(40);
        running -= 1;
        return HttpResponse.json(response(3, `a${10 + bodies.length}`, bodies.length));
      }),
    );
    const { hook } = setup();

    act(() => {
      hook.result.current.mutate({ cardId: cardId(3), target: between });
      hook.result.current.mutate({
        cardId: cardId(3),
        target: { columnId: ids.doing, index: 0, afterId: null, beforeId: cardId(4) },
      });
      hook.result.current.mutate({ cardId: cardId(3), target: between });
    });
    await waitFor(() => expect(bodies).toHaveLength(3), { timeout: 3000 });
    expect(overlapped).toBe(false);
    expect(bodies.map((b) => (b as { columnId: string }).columnId)).toEqual([
      ids.todo,
      ids.doing,
      ids.todo,
    ]); // in the order they were made
  });
});

describe('quick repeated moves of one card', () => {
  const second: DropTarget = {
    columnId: ids.todo,
    index: 0,
    afterId: null,
    beforeId: cardId(1),
  };
  /** Every position the screen showed for card 3, in order. */
  const watchPositions = (client: QueryClient) => {
    const seen: string[] = [];
    const read = () => {
      const position = client
        .getQueryData<BoardSnapshot>(boardKey(ids.board))
        ?.cards.find((c) => c.id === cardId(3))?.position;
      if (position && seen.at(-1) !== position) seen.push(position);
    };
    read();
    client.getQueryCache().subscribe(read);
    return seen;
  };
  const answerInTurn = (answers: (() => Response | Promise<Response>)[]) => {
    let call = 0;
    server.use(
      http.post('http://localhost/api/cards/:id/move', async () => {
        await delay(60);
        const answer = answers[call] ?? answers.at(-1)!;
        call += 1;
        return answer();
      }),
    );
  };
  const both = (hook: ReturnType<typeof setup>['hook']) =>
    act(() => {
      hook.result.current.mutate({ cardId: cardId(3), target: between });
      hook.result.current.mutate({ cardId: cardId(3), target: second });
    });

  it('the first answer does not pull the card back while the second move is still shown; the last answer places it', async () => {
    answerInTurn([
      () => HttpResponse.json(response(3, 'a11', 4)),
      () => HttpResponse.json(response(3, 'a12', 5)),
    ]);
    const { client, hook, positionOf } = setup();
    const seen = watchPositions(client);

    both(hook);
    await waitFor(() => expect(positionOf(3).position).toBe('a12'), { timeout: 3000 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(seen).not.toContain('a11'); // the first answer was outdated by the time it arrived
    expect(positionOf(3).position).toBe('a12');
  });

  it('when both moves are refused the card goes back to where the server has it, not to a guess', async () => {
    answerInTurn([forbidden, forbidden]);
    const { hook, snapshot, positionOf } = setup();
    const original = positionOf(3).position;

    both(hook);
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(positionOf(3)).toMatchObject({ position: original, columnId: ids.todo });
    expect(cardsOfColumn(snapshot(), ids.todo).map((c) => c.title)).toEqual([
      'Card 1',
      'Card 2',
      'Card 3',
    ]);
  });

  it('when the first is accepted and the second refused the card stays where the first put it', async () => {
    answerInTurn([() => HttpResponse.json(response(3, 'a11', 4)), forbidden]);
    const { hook, positionOf } = setup();

    both(hook);
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(positionOf(3).position).toBe('a11');
  });

  it('a newer announcement that arrives meanwhile is kept and applied afterwards; an older one is dropped', async () => {
    const announced = (eventId: number, position: string) => ({
      eventId,
      boardId: ids.board,
      actorId: null,
      clientMutationId: null,
      card: card(3, { position }),
      fromColumnId: ids.todo,
    });
    answerInTurn([() => HttpResponse.json(response(3, 'a15', 4))]);
    const { hook, positionOf } = setup();

    expect(deferAnnouncement(cardId(3), announced(9, 'a20'))).toBe(false); // nothing pending yet: apply at once
    act(() => hook.result.current.mutate({ cardId: cardId(3), target: between }));
    await waitFor(() => expect(hook.result.current.isPending).toBe(true));
    expect(deferAnnouncement(cardId(3), announced(10, 'a30'))).toBe(true); // held back
    expect(deferAnnouncement(cardId(3), announced(2, 'a01'))).toBe(true); // an older one never wins
    expect(positionOf(3).position).not.toBe('a30'); // not shown yet

    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(positionOf(3).position).toBe('a30')); // announced later than our answer
  });
});
