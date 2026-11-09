import type { BoardSnapshot } from '@kanban/shared';
import type { ReactNode } from 'react';

import { loadPrivate } from '@/shared/lib/server-api';
import { BoardProvider } from './board-provider';

/**
 * Loads the board once on the server and keeps it for both the board page and the card page
 * (and the card modal, which is a parallel route rendered next to the board).
 */
export default async function BoardLayout({
  children,
  modal,
  params,
}: {
  children: ReactNode;
  modal: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const snapshot = await loadPrivate<BoardSnapshot>(`/boards/${id}`);
  return (
    <BoardProvider boardId={id} snapshot={snapshot}>
      {children}
      {modal}
    </BoardProvider>
  );
}
