import type { BoardSnapshot } from '@kanban/shared';

import { loadPrivate } from '@/shared/lib/server-api';
import { BoardScreen } from './board-screen';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const snapshot = await loadPrivate<BoardSnapshot>(`/boards/${id}`);
  return { title: snapshot.board.name };
}

export default async function BoardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const snapshot = await loadPrivate<BoardSnapshot>(`/boards/${id}`);
  return <BoardScreen boardId={id} initial={snapshot} />;
}
