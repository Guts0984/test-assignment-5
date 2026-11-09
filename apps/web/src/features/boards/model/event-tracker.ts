/**
 * Remembers, per entity, the newest change already applied, so an event is applied only if it is
 * not older than what the cache already shows. This is what keeps a client's own change from
 * "jumping" when its echo arrives over the socket, and makes late or repeated deliveries harmless.
 * The server numbers every board change with an increasing `eventId`; an equal id is accepted
 * (applying the same change twice is harmless) so that two messages about one change, such as a
 * move and the rebalance it caused, may arrive in either order.
 */
export type EventTracker = {
  accept: (entityKey: string, eventId: number) => boolean;
  /** After a (re)join: everything up to `eventId` is already inside the snapshot. */
  reset: (eventId: number) => void;
};

export const createEventTracker = (): EventTracker => {
  const latest = new Map<string, number>();
  let floor = 0;
  return {
    accept: (entityKey, eventId) => {
      if (eventId < Math.max(floor, latest.get(entityKey) ?? 0)) return false;
      latest.set(entityKey, eventId);
      return true;
    },
    reset: (eventId) => {
      latest.clear();
      floor = eventId;
    },
  };
};

const registry = new Map<string, EventTracker>();

/** One tracker per board, shared by the socket handlers and the mutations of that board. */
export const trackerFor = (boardId: string): EventTracker => {
  let tracker = registry.get(boardId);
  if (!tracker) {
    tracker = createEventTracker();
    registry.set(boardId, tracker);
  }
  return tracker;
};
