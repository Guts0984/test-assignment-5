'use client';

import type { BoardSnapshot, Card } from '@kanban/shared';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useMemo, useState } from 'react';

import { useMoveCard } from '../api/move-card';
import { useBoard } from '../api/use-board';
import { compareCards, resolveDrop } from '../model/order';
import { CardOverlay } from './card-tile';
import { BoardColumn } from './column';

/** Pointer first (where the mouse is), rectangles as the fallback (keyboard dragging). */
const collisions: CollisionDetection = (args) => {
  const pointer = pointerWithin(args);
  return pointer.length > 0 ? pointer : rectIntersection(args);
};

const groupByColumn = (snapshot: BoardSnapshot): Map<string, Card[]> => {
  const groups = new Map<string, Card[]>(snapshot.columns.map((column) => [column.id, []]));
  for (const card of snapshot.cards) groups.get(card.columnId)?.push(card);
  for (const list of groups.values()) list.sort(compareCards);
  return groups;
};

export const BoardView = ({
  boardId,
  initial,
  editors,
}: {
  boardId: string;
  initial: BoardSnapshot;
  editors: Record<string, string>;
}) => {
  const { data: snapshot } = useBoard(boardId, initial);
  const move = useMoveCard(boardId);
  const canEdit = snapshot.role !== 'viewer';
  const [activeId, setActiveId] = useState<string | null>(null);

  // A viewer gets no sensors at all: nothing can be picked up, by mouse or keyboard.
  const pointer = useSensor(PointerSensor, { activationConstraint: { distance: 6 } });
  const keyboard = useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates });
  const sensors = useSensors(...(canEdit ? [pointer, keyboard] : []));

  const groups = useMemo(() => groupByColumn(snapshot), [snapshot]);
  const active = activeId ? snapshot.cards.find((card) => card.id === activeId) : undefined;

  const columnName = (id: string) =>
    snapshot.columns.find((column) => column.id === id)?.name ?? 'a column';
  const titleOf = (id: string | number) =>
    snapshot.cards.find((card) => card.id === id)?.title ?? 'card';
  const announcements: Announcements = {
    onDragStart: ({ active: a }) => `Picked up card ${titleOf(a.id)}.`,
    onDragOver: ({ active: a, over }) =>
      over
        ? `Card ${titleOf(a.id)} is over ${over.id.toString().startsWith('column:') ? columnName(over.id.toString().slice(7)) : `card ${titleOf(over.id)}`}.`
        : undefined,
    onDragEnd: ({ active: a }) => `Dropped card ${titleOf(a.id)}.`,
    onDragCancel: ({ active: a }) => `Moving card ${titleOf(a.id)} was cancelled.`,
  };

  const onDragEnd = ({ active: dragged, over }: DragEndEvent) => {
    setActiveId(null);
    if (!over || !canEdit) return;
    const target = resolveDrop(snapshot, String(dragged.id), String(over.id));
    if (!target) return;
    // Dropping a card back where it already is changes nothing: do not send a request.
    const list = groups.get(target.columnId) ?? [];
    const at = list.findIndex((candidate) => candidate.id === dragged.id);
    if (
      at !== -1 &&
      target.afterId === (list[at - 1]?.id ?? null) &&
      target.beforeId === (list[at + 1]?.id ?? null)
    )
      return;
    move.mutate({ cardId: String(dragged.id), target });
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisions}
      accessibility={{ announcements }}
      onDragStart={({ active: a }: DragStartEvent) => setActiveId(String(a.id))}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div
        className="flex h-full items-start gap-3 overflow-x-auto p-4"
        role="group"
        aria-label="Board columns"
      >
        {snapshot.columns.map((column) => (
          <BoardColumn
            key={column.id}
            boardId={boardId}
            column={column}
            cards={groups.get(column.id) ?? []}
            canEdit={canEdit}
            editors={editors}
          />
        ))}
      </div>
      <DragOverlay>{active ? <CardOverlay card={active} /> : null}</DragOverlay>
    </DndContext>
  );
};
