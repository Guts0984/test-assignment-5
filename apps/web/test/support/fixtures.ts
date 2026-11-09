import type { BoardSnapshot, Card } from '@kanban/shared';

const T = '2026-01-01T00:00:00.000Z';
export const ids = {
  board: '11111111-1111-4111-8111-111111111111',
  todo: '22222222-2222-4222-8222-222222222221',
  doing: '22222222-2222-4222-8222-222222222222',
  user: '33333333-3333-4333-8333-333333333333',
};
export const cardId = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;

export const card = (n: number, overrides: Partial<Card> = {}): Card => ({
  id: cardId(n),
  boardId: ids.board,
  columnId: ids.todo,
  title: `Card ${n}`,
  description: '',
  position: `a${n}`,
  version: 1,
  createdBy: ids.user,
  createdAt: T,
  updatedAt: T,
  ...overrides,
});

/** Three cards in "todo" (a1, a2, a3), one in "doing" (a1). */
export const board = (role: BoardSnapshot['role'] = 'editor'): BoardSnapshot => ({
  board: { id: ids.board, workspaceId: '55555555-5555-4555-8555-555555555555', name: 'Roadmap' },
  role,
  columns: [
    { id: ids.todo, boardId: ids.board, name: 'To do', position: 'a0' },
    { id: ids.doing, boardId: ids.board, name: 'Doing', position: 'a1' },
  ],
  cards: [card(1), card(2), card(3), card(4, { columnId: ids.doing })],
});
