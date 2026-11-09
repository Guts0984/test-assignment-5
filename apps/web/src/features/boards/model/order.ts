import type { BoardSnapshot, Card } from '@kanban/shared';
import { generateKeyBetween } from 'fractional-indexing';

/** Board order: by key (byte-wise, like the database), ties broken by id. */
export const compareCards = (
  a: Pick<Card, 'position' | 'id'>,
  b: Pick<Card, 'position' | 'id'>,
): number =>
  a.position < b.position
    ? -1
    : a.position > b.position
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

export const cardsOfColumn = (snapshot: BoardSnapshot, columnId: string): Card[] =>
  snapshot.cards.filter((card) => card.columnId === columnId).sort(compareCards);

/** A key that places a card between two neighbours; replaced by the server's key once it answers. */
export const optimisticKey = (before: string | null, after: string | null): string => {
  try {
    return generateKeyBetween(before, after);
  } catch {
    return before ?? after ?? 'a0'; // inconsistent neighbours: the server decides
  }
};

export type DropTarget = {
  columnId: string;
  afterId: string | null;
  beforeId: string | null;
  index: number;
};

export const COLUMN_DROP_PREFIX = 'column:';
export const columnDropId = (columnId: string): string => `${COLUMN_DROP_PREFIX}${columnId}`;

/**
 * Where a dragged card lands, as the neighbours the API wants (`afterId` directly above,
 * `beforeId` directly below). `overId` is the card or column the pointer / keyboard is over.
 * Dropping on a column puts the card at its end; dropping on a card in the same column moves it
 * to that card's place (down: after it, up: before it); into another column: before it.
 */
export const resolveDrop = (
  snapshot: BoardSnapshot,
  activeId: string,
  overId: string,
): DropTarget | null => {
  const active = snapshot.cards.find((card) => card.id === activeId);
  if (!active) return null;

  let columnId: string;
  let overCard: Card | undefined;
  if (overId.startsWith(COLUMN_DROP_PREFIX)) {
    columnId = overId.slice(COLUMN_DROP_PREFIX.length);
  } else {
    overCard = snapshot.cards.find((card) => card.id === overId);
    if (!overCard) return null;
    // Released over the card's own place (picked up and put back): nothing to move.
    if (overCard.id === activeId) return null;
    columnId = overCard.columnId;
  }
  if (!snapshot.columns.some((column) => column.id === columnId)) return null;

  const full = cardsOfColumn(snapshot, columnId);
  const others = full.filter((card) => card.id !== activeId);
  let index = others.length;
  if (overCard) {
    const overIndexInOthers = others.findIndex((card) => card.id === overCard.id);
    const movingDown =
      active.columnId === columnId &&
      full.findIndex((card) => card.id === activeId) <
        full.findIndex((card) => card.id === overCard.id);
    index = movingDown ? overIndexInOthers + 1 : overIndexInOthers;
  }
  return {
    columnId,
    index,
    afterId: others[index - 1]?.id ?? null,
    beforeId: others[index]?.id ?? null,
  };
};
