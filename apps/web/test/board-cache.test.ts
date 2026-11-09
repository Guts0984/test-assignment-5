import type { Card, ServerEventPayload } from '@kanban/shared';
import { describe, expect, it } from 'vitest';

import { applyEvent, upsertCard } from '@/features/boards/model/board-cache';
import { createEventTracker } from '@/features/boards/model/event-tracker';
import { cardsOfColumn, columnDropId, resolveDrop } from '@/features/boards/model/order';
import { board, card, cardId, ids } from './support/fixtures';

const envelope = (eventId: number) => ({
  eventId,
  boardId: ids.board,
  actorId: null,
  clientMutationId: null,
});
const moved = (c: Card, eventId: number): ServerEventPayload<'card.moved'> => ({
  ...envelope(eventId),
  card: c,
  fromColumnId: ids.todo,
});
const order = (snapshot: ReturnType<typeof board>, columnId = ids.todo) =>
  cardsOfColumn(snapshot, columnId).map((c) => c.title);

describe('applying realtime events to the cached board', () => {
  it('patches only the card an event is about', () => {
    const before = board();
    const after = applyEvent(
      before,
      'card.moved',
      moved(card(1, { position: 'a25' }), 5),
      createEventTracker(),
    );
    expect(order(after)).toEqual(['Card 2', 'Card 1', 'Card 3']);
    expect(after.cards.find((c) => c.id === cardId(2))).toBe(
      before.cards.find((c) => c.id === cardId(2)),
    ); // untouched, same object
  });

  it('ignores an event that is older than what is already shown (late or reordered delivery)', () => {
    const tracker = createEventTracker();
    let snapshot = applyEvent(
      board(),
      'card.moved',
      moved(card(1, { position: 'a9' }), 10),
      tracker,
    );
    snapshot = applyEvent(snapshot, 'card.moved', moved(card(1, { position: 'a0' }), 7), tracker); // arrives late
    expect(order(snapshot)).toEqual(['Card 2', 'Card 3', 'Card 1']); // still where event 10 put it
  });

  it('applies the same change twice without effect: the echo of our own move does not move the card again', () => {
    const tracker = createEventTracker();
    const first = applyEvent(
      board(),
      'card.moved',
      moved(card(1, { position: 'a25' }), 5),
      tracker,
    );
    const echo = applyEvent(first, 'card.moved', moved(card(1, { position: 'a25' }), 5), tracker);
    expect(order(echo)).toEqual(order(first));
  });

  it('does not apply what the snapshot already contains after a reconnect', () => {
    const tracker = createEventTracker();
    tracker.reset(20); // the snapshot we got on joining includes everything up to event 20
    const after = applyEvent(
      board(),
      'card.moved',
      moved(card(1, { position: 'a9' }), 12),
      tracker,
    );
    expect(order(after)).toEqual(['Card 1', 'Card 2', 'Card 3']);
  });

  it('keeps entities independent: an old event for one card does not block a newer one for another', () => {
    const tracker = createEventTracker();
    let snapshot = applyEvent(
      board(),
      'card.moved',
      moved(card(1, { position: 'a9' }), 30),
      tracker,
    );
    snapshot = applyEvent(snapshot, 'card.moved', moved(card(2, { position: 'a8' }), 25), tracker);
    expect(order(snapshot)).toEqual(['Card 3', 'Card 2', 'Card 1']);
  });

  it('creates, edits (never back to an older version) and deletes cards', () => {
    const tracker = createEventTracker();
    let snapshot = applyEvent(
      board(),
      'card.created',
      { ...envelope(1), card: card(9, { position: 'a99' }) },
      tracker,
    );
    expect(order(snapshot)).toContain('Card 9');
    snapshot = applyEvent(
      snapshot,
      'card.updated',
      { ...envelope(2), card: card(9, { title: 'Renamed', version: 3, position: 'a99' }) },
      tracker,
    );
    expect(order(snapshot)).toContain('Renamed');
    snapshot = upsertCard(
      snapshot,
      card(9, { title: 'Stale edition', version: 2, position: 'a99' }),
    );
    expect(order(snapshot)).toContain('Renamed');
    snapshot = applyEvent(
      snapshot,
      'card.deleted',
      { ...envelope(3), cardId: cardId(9), columnId: ids.todo },
      tracker,
    );
    expect(snapshot.cards.some((c) => c.id === cardId(9))).toBe(false);
  });

  it('applies a rebalanced column in one go, and accepts the move and the rebalance in either order', () => {
    const positions = [
      { id: cardId(1), position: 'a0' },
      { id: cardId(2), position: 'a1' },
      { id: cardId(3), position: 'a2' },
    ];
    const rebalance: ServerEventPayload<'column.rebalanced'> = {
      ...envelope(8),
      columnId: ids.todo,
      positions,
    };
    const move = moved(card(3, { position: 'a2' }), 8);
    for (const events of [
      [rebalance, move],
      [move, rebalance],
    ] as const) {
      const tracker = createEventTracker();
      let snapshot = board();
      for (const event of events)
        snapshot =
          'positions' in event
            ? applyEvent(snapshot, 'column.rebalanced', event, tracker)
            : applyEvent(snapshot, 'card.moved', event, tracker);
      expect(
        snapshot.cards
          .filter((c) => c.columnId === ids.todo)
          .map((c) => c.position)
          .sort(),
      ).toEqual(['a0', 'a1', 'a2']);
    }
  });
});

describe('where a dropped card lands', () => {
  const drop = (activeId: string, overId: string) => resolveDrop(board(), activeId, overId);

  it('putting a card back on its own place is not a move (it must not jump to the end of the column)', () => {
    for (const n of [1, 2, 3]) expect(drop(cardId(n), cardId(n))).toBeNull();
  });

  it('dropping on a card in the same column: moving down puts it after, moving up puts it before', () => {
    expect(drop(cardId(1), cardId(3))).toMatchObject({
      columnId: ids.todo,
      afterId: cardId(3),
      beforeId: null,
    });
    expect(drop(cardId(3), cardId(1))).toMatchObject({
      columnId: ids.todo,
      afterId: null,
      beforeId: cardId(1),
    });
    expect(drop(cardId(1), cardId(2))).toMatchObject({ afterId: cardId(2), beforeId: cardId(3) });
  });

  it('dropping on a card in another column puts it before that card', () => {
    expect(drop(cardId(2), cardId(4))).toMatchObject({
      columnId: ids.doing,
      afterId: null,
      beforeId: cardId(4),
    });
  });

  it('dropping on a column puts the card at its end (or alone, in an empty column)', () => {
    expect(drop(cardId(1), columnDropId(ids.doing))).toMatchObject({
      columnId: ids.doing,
      afterId: cardId(4),
      beforeId: null,
    });
    expect(drop(cardId(1), columnDropId(ids.todo))).toMatchObject({
      afterId: cardId(3),
      beforeId: null,
    });
  });

  it('refuses nonsense: unknown cards or columns', () => {
    expect(drop('nope', cardId(1))).toBeNull();
    expect(drop(cardId(1), 'nope')).toBeNull();
    expect(drop(cardId(1), columnDropId('nope'))).toBeNull();
  });
});
