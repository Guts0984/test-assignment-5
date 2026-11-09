/**
 * Boards this browser tab is deleting itself. The server also announces a deletion to everyone
 * watching, including the person who did it; this lets the realtime layer skip the "someone
 * deleted this board" notice for them.
 */
const deletedHere = new Set<string>();

export const markDeletedHere = (boardId: string): void => {
  deletedHere.add(boardId);
};
export const wasDeletedHere = (boardId: string): boolean => deletedHere.has(boardId);
