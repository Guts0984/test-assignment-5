'use client';

import type { Card } from '@kanban/shared';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import Link from 'next/link';
import { memo } from 'react';

import { cn } from '@/shared/lib/cn';

/** Fixed height: the big column is virtualized and needs to know row sizes without measuring. */
export const CARD_ROW_HEIGHT = 88;

export const CardBody = ({
  card,
  boardId,
  editing,
}: {
  card: Card;
  boardId: string;
  editing?: string | undefined;
}) => (
  <div className="min-w-0 flex-1">
    <Link
      href={`/boards/${boardId}/cards/${card.id}`}
      prefetch={false}
      className="line-clamp-2 text-sm font-medium underline-offset-2 hover:underline"
    >
      {card.title}
    </Link>
    {editing ? <p className="mt-1 truncate text-xs text-primary">{editing} is editing</p> : null}
  </div>
);

/** What is shown under the pointer while dragging; no dnd hooks, so it is cheap and static. */
export const CardOverlay = ({ card }: { card: Card }) => (
  <div className="flex h-[76px] items-start gap-2 rounded-md border border-primary bg-background p-3 shadow-lg">
    <GripVertical className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
    <p className="line-clamp-2 text-sm font-medium">{card.title}</p>
  </div>
);

type CardTileProps = {
  card: Card;
  boardId: string;
  canMove: boolean;
  editing?: string | undefined;
};

export const CardTile = memo(function CardTile({ card, boardId, canMove, editing }: CardTileProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.id, disabled: !canMove });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'flex h-[76px] items-start gap-2 rounded-md border border-border bg-background p-3',
        isDragging && 'opacity-40',
      )}
    >
      {canMove ? (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Move card ${card.title}`}
          className="mt-0.5 cursor-grab touch-none rounded text-muted-foreground hover:text-foreground"
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>
      ) : (
        <span className="w-4 shrink-0" aria-hidden />
      )}
      <CardBody card={card} boardId={boardId} editing={editing} />
    </div>
  );
});
