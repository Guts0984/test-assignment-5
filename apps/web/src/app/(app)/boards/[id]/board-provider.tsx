'use client';

import type { BoardSnapshot } from '@kanban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { boardKey } from '@/features/boards';
import { RealtimeProvider } from '@/features/realtime';

/** Puts the server-rendered board into the cache once, then keeps the board live over the socket. */
export const BoardProvider = ({
  boardId,
  snapshot,
  children,
}: {
  boardId: string;
  snapshot: BoardSnapshot;
  children: ReactNode;
}) => {
  const client = useQueryClient();
  useState(() => {
    if (!client.getQueryData(boardKey(boardId))) client.setQueryData(boardKey(boardId), snapshot);
    return null;
  });
  return <RealtimeProvider boardId={boardId}>{children}</RealtimeProvider>;
};
