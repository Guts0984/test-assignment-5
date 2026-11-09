import type { ServerEventPayload } from '@kanban/shared';

/**
 * What the screen must remember about a card while moves of it are still on their way:
 *  - `confirmed`: the last place the SERVER put the card (or where it was before the first
 *    pending move), which is where a refused move must send it back. The optimistic places in
 *    between were only guesses and may never have existed on the server;
 *  - `deferred`: the newest socket announcement of a move of this card that arrived meanwhile. It
 *    is applied once the last of our moves has finished, so neither our own echoes nor someone
 *    else's move make the card jump around under the pointer.
 */
type Place = { columnId: string; position: string };
type Entry = { count: number; confirmed: Place; deferred: ServerEventPayload<'card.moved'> | null };

const entries = new Map<string, Entry>();

/** A move of this card starts. `current` is only used for the first one of a series. */
export const beginMove = (cardId: string, current: Place): void => {
  const entry = entries.get(cardId);
  if (entry) entry.count += 1;
  else entries.set(cardId, { count: 1, confirmed: current, deferred: null });
};

export const confirmMove = (cardId: string, place: Place): void => {
  const entry = entries.get(cardId);
  if (entry) entry.confirmed = place;
};

/** Is another move of this card still waiting behind the one that just finished? */
export const hasLaterMove = (cardId: string): boolean => (entries.get(cardId)?.count ?? 0) > 1;

export const confirmedPlace = (cardId: string): Place | undefined => entries.get(cardId)?.confirmed;

/** Keeps a socket announcement for later. False: no move of this card is pending, apply it now. */
export const deferAnnouncement = (
  cardId: string,
  event: ServerEventPayload<'card.moved'>,
): boolean => {
  const entry = entries.get(cardId);
  if (!entry) return false;
  if (!entry.deferred || event.eventId > entry.deferred.eventId) entry.deferred = event;
  return true;
};

/** A move finished (either way). Returns the kept announcement once it was the last one. */
export const endMove = (cardId: string): ServerEventPayload<'card.moved'> | null => {
  const entry = entries.get(cardId);
  if (!entry) return null;
  entry.count -= 1;
  if (entry.count > 0) return null;
  entries.delete(cardId);
  return entry.deferred;
};
