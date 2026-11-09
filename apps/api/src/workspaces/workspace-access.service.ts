import { attachments, boards, cards, workspaceMembers, type DatabaseHandle } from '@kanban/db';
import type { WorkspaceRole } from '@kanban/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';

import { AppError } from '../common/app-error';
import { DATABASE } from '../infra/tokens';

const RANK: Record<WorkspaceRole, number> = { viewer: 1, editor: 2, owner: 3 };

export const atLeast = (role: WorkspaceRole, minimum: WorkspaceRole): boolean =>
  RANK[role] >= RANK[minimum];

/**
 * The single place that answers "may this user do this in this workspace?". Every endpoint
 * that touches workspace data goes through it (directly, or through the resolvers that map a
 * board, card or attachment to its workspace).
 *
 *  - Not a member (or the workspace does not exist): 404. The two cases are indistinguishable,
 *    so ids of other people's workspaces can never be probed.
 *  - A member whose role is too low: 403.
 * Membership is read from the database on every call, so removing a member takes effect on
 * their very next request.
 */
@Injectable()
export class WorkspaceAccessService {
  constructor(@Inject(DATABASE) private readonly database: DatabaseHandle) {}

  async roleOf(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const [row] = await this.database.db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
      )
      .limit(1);
    return row?.role ?? null;
  }

  /** Returns the caller's role, or throws 404 / 403. */
  async require(
    userId: string,
    workspaceId: string,
    minimum: WorkspaceRole = 'viewer',
  ): Promise<WorkspaceRole> {
    const role = await this.roleOf(userId, workspaceId);
    if (!role) throw new AppError('not_found', 'Not found');
    if (!atLeast(role, minimum))
      throw new AppError('forbidden', 'You do not have permission to do this');
    return role;
  }

  /**
   * Access to a board through its workspace. A board that does not exist and a board in a
   * workspace the caller is not in look exactly the same: 404, and so does a deleted board.
   */
  async requireForBoard(userId: string, boardId: string, minimum: WorkspaceRole = 'viewer') {
    const [board] = await this.database.db
      .select({ workspaceId: boards.workspaceId })
      .from(boards)
      .where(and(eq(boards.id, boardId), isNull(boards.deletedAt)))
      .limit(1);
    if (!board) throw new AppError('not_found', 'Not found');
    const role = await this.require(userId, board.workspaceId, minimum);
    return { workspaceId: board.workspaceId, boardId, role };
  }

  /** Same for a card (deleted cards do not exist for anyone). */
  async requireForCard(userId: string, cardId: string, minimum: WorkspaceRole = 'viewer') {
    const [card] = await this.database.db
      .select({ workspaceId: cards.workspaceId, boardId: cards.boardId, columnId: cards.columnId })
      .from(cards)
      .where(and(eq(cards.id, cardId), isNull(cards.deletedAt)))
      .limit(1);
    if (!card) throw new AppError('not_found', 'Not found');
    const role = await this.require(userId, card.workspaceId, minimum);
    return { ...card, cardId, role };
  }

  /** Same for an attachment; one whose card was deleted does not exist for anyone. */
  async requireForAttachment(
    userId: string,
    attachmentId: string,
    minimum: WorkspaceRole = 'viewer',
  ) {
    const [row] = await this.database.db
      .select({
        workspaceId: attachments.workspaceId,
        cardId: attachments.cardId,
        boardId: cards.boardId,
      })
      .from(attachments)
      .innerJoin(cards, and(eq(cards.id, attachments.cardId), isNull(cards.deletedAt)))
      .where(eq(attachments.id, attachmentId))
      .limit(1);
    if (!row) throw new AppError('not_found', 'Not found');
    const role = await this.require(userId, row.workspaceId, minimum);
    return { ...row, attachmentId, role };
  }
}
