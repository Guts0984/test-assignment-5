'use client';

import type { Card, Column as ColumnType } from '@kanban/shared';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useRef } from 'react';

import { cn } from '@/shared/lib/cn';
import { columnDropId } from '../model/order';
import { AddCardForm } from './add-card-form';
import { CARD_ROW_HEIGHT, CardTile } from './card-tile';

/** Short columns are rendered in full (keyboard dragging then reaches every card). */
const VIRTUALIZE_ABOVE = 60;
const GAP = 8;

type ColumnProps = {
  boardId: string;
  column: ColumnType;
  cards: Card[];
  canEdit: boolean;
  /** card id -> name of the person editing it right now */
  editors: Record<string, string>;
};

export const BoardColumn = memo(function BoardColumn({
  boardId,
  column,
  cards,
  canEdit,
  editors,
}: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: columnDropId(column.id), disabled: !canEdit });
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = cards.length > VIRTUALIZE_ABOVE;
  const virtualizer = useVirtualizer({
    count: virtual ? cards.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CARD_ROW_HEIGHT,
    overscan: 10,
  });

  return (
    <section
      aria-labelledby={`col-${column.id}`}
      className="flex max-h-full w-72 shrink-0 flex-col rounded-lg border border-border bg-muted/50"
    >
      <h2 id={`col-${column.id}`} className="px-3 py-2 text-sm font-semibold">
        {column.name} <span className="font-normal text-muted-foreground">({cards.length})</span>
      </h2>
      <div
        ref={(node) => {
          setNodeRef(node);
          scrollRef.current = node;
        }}
        className={cn('min-h-16 flex-1 overflow-y-auto px-2 pb-2', isOver && 'bg-primary/10')}
      >
        <SortableContext
          items={cards.map((card) => card.id)}
          strategy={verticalListSortingStrategy}
        >
          {virtual ? (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((row) => {
                const card = cards[row.index]!;
                return (
                  <div
                    key={card.id}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      height: CARD_ROW_HEIGHT - GAP,
                      transform: `translateY(${row.start}px)`,
                    }}
                  >
                    <CardTile
                      card={card}
                      boardId={boardId}
                      canMove={canEdit}
                      editing={editors[card.id]}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <ul className="grid gap-2">
              {cards.map((card) => (
                <li key={card.id}>
                  <CardTile
                    card={card}
                    boardId={boardId}
                    canMove={canEdit}
                    editing={editors[card.id]}
                  />
                </li>
              ))}
            </ul>
          )}
        </SortableContext>
      </div>
      {canEdit ? (
        <AddCardForm boardId={boardId} columnId={column.id} columnName={column.name} />
      ) : null}
    </section>
  );
});
