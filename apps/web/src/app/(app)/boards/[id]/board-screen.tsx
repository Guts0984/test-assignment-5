'use client';

import type { BoardSnapshot } from '@kanban/shared';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo } from 'react';

import { BoardMenu, BoardView, boardKey } from '@/features/boards';
import { PresenceBar } from '@/features/presence';
import { useRealtime } from '@/features/realtime';

const STATUS = {
  connecting: 'Connecting…',
  live: 'Live',
  offline: 'Offline: reconnecting…',
} as const;

export const BoardScreen = ({ boardId, initial }: { boardId: string; initial: BoardSnapshot }) => {
  const { status, presence } = useRealtime();
  const { data } = useQuery<BoardSnapshot>({
    queryKey: boardKey(boardId),
    enabled: false,
    initialData: initial,
  });
  const editors = useMemo(
    () =>
      Object.fromEntries(
        presence
          .filter((p) => p.editingCardId)
          .map((p) => [p.editingCardId as string, p.user.name]),
      ),
    [presence],
  );
  const snapshot = data ?? initial;
  return (
    <div className="flex h-[calc(100vh-3.25rem)] flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm underline">
            ← Boards
          </Link>
          <h1 className="text-lg font-semibold">{snapshot.board.name}</h1>
          <span className="rounded bg-muted px-2 py-0.5 text-xs">{snapshot.role}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <BoardMenu board={snapshot.board} />
          <PresenceBar users={presence} currentUserId="" />
          <span
            role="status"
            className={`text-xs ${status === 'live' ? 'text-muted-foreground' : 'text-danger'}`}
          >
            {STATUS[status]}
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <BoardView boardId={boardId} initial={initial} editors={editors} />
      </div>
    </div>
  );
};
