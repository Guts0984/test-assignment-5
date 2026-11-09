/** Query keys of this feature. The board is one entry: realtime events patch it, never reload it. */
export const boardKey = (boardId: string) => ['board', boardId] as const;
