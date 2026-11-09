import type { BoardSnapshot, Card, ServerEventName, ServerEventPayload } from '@kanban/shared';

import type { EventTracker } from './event-tracker';

/**
 * Pure functions that turn the cached board into the next one. The cache is never reloaded for a
 * change from another user: the one card (or position) that changed is patched in place.
 */
const withCards = (snapshot: BoardSnapshot, cards: Card[]): BoardSnapshot => ({
  ...snapshot,
  cards,
});

export const upsertCard = (snapshot: BoardSnapshot, card: Card): BoardSnapshot => {
  const index = snapshot.cards.findIndex((existing) => existing.id === card.id);
  if (index === -1) return withCards(snapshot, [...snapshot.cards, card]);
  const existing = snapshot.cards[index]!;
  // Content changes carry a version; never replace a card with an older edition of it.
  if (card.version < existing.version) return snapshot;
  return withCards(
    snapshot,
    snapshot.cards.map((candidate, i) => (i === index ? card : candidate)),
  );
};

export const removeCard = (snapshot: BoardSnapshot, cardId: string): BoardSnapshot =>
  snapshot.cards.some((card) => card.id === cardId)
    ? withCards(
        snapshot,
        snapshot.cards.filter((card) => card.id !== cardId),
      )
    : snapshot;

/** Optimistic and rollback moves: change where one card is, nothing else. */
export const placeCard = (
  snapshot: BoardSnapshot,
  cardId: string,
  place: { columnId: string; position: string },
): BoardSnapshot =>
  withCards(
    snapshot,
    snapshot.cards.map((card) => (card.id === cardId ? { ...card, ...place } : card)),
  );

/** A card from the server after a move: position and column are authoritative, content is kept. */
const applyMovedCard = (snapshot: BoardSnapshot, card: Card): BoardSnapshot => {
  if (!snapshot.cards.some((existing) => existing.id === card.id))
    return withCards(snapshot, [...snapshot.cards, card]);
  return withCards(
    snapshot,
    snapshot.cards.map((existing) =>
      existing.id === card.id
        ? {
            ...existing,
            columnId: card.columnId,
            position: card.position,
            updatedAt: card.updatedAt,
          }
        : existing,
    ),
  );
};

export const applyMove = (
  snapshot: BoardSnapshot,
  card: Card,
  eventId: number,
  tracker: EventTracker,
): BoardSnapshot =>
  tracker.accept(`card:${card.id}`, eventId) ? applyMovedCard(snapshot, card) : snapshot;

/** Applies one realtime event. Returns the same object if nothing changed. */
export const applyEvent = <K extends ServerEventName>(
  snapshot: BoardSnapshot,
  name: K,
  payload: ServerEventPayload<K>,
  tracker: EventTracker,
): BoardSnapshot => {
  switch (name) {
    case 'card.created': {
      const event = payload as ServerEventPayload<'card.created'>;
      return tracker.accept(`card:${event.card.id}`, event.eventId)
        ? upsertCard(snapshot, event.card)
        : snapshot;
    }
    case 'card.updated': {
      const event = payload as ServerEventPayload<'card.updated'>;
      return tracker.accept(`card:${event.card.id}`, event.eventId)
        ? upsertCard(snapshot, event.card)
        : snapshot;
    }
    case 'card.moved': {
      const event = payload as ServerEventPayload<'card.moved'>;
      return applyMove(snapshot, event.card, event.eventId, tracker);
    }
    case 'card.deleted': {
      const event = payload as ServerEventPayload<'card.deleted'>;
      return tracker.accept(`card:${event.cardId}`, event.eventId)
        ? removeCard(snapshot, event.cardId)
        : snapshot;
    }
    case 'column.rebalanced': {
      const event = payload as ServerEventPayload<'column.rebalanced'>;
      const keys = new Map(
        event.positions
          .filter((entry) => tracker.accept(`card:${entry.id}`, event.eventId))
          .map((entry) => [entry.id, entry.position]),
      );
      if (keys.size === 0) return snapshot;
      return withCards(
        snapshot,
        snapshot.cards.map((card) =>
          keys.has(card.id) ? { ...card, position: keys.get(card.id) ?? card.position } : card,
        ),
      );
    }
    default:
      return snapshot;
  }
};
