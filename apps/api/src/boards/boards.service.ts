import {
  boardColumns,
  boards,
  cards,
  columnPositions,
  createCardInTx,
  evenlySpacedKeys,
  type DatabaseHandle,
} from '@kanban/db';
import {
  DEFAULT_COLUMN_NAMES,
  type BoardSnapshot,
  type Card,
  type CreateBoardBody,
  type CreatedBoard,
  type CreateCardBody,
  type RenameBoardBody,
  type WorkspaceRole,
} from '@kanban/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';

import type { AuthUser } from '../auth/auth-user';
import { AppError } from '../common/app-error';
import { DATABASE } from '../infra/tokens';
import { BoardEvents } from '../realtime/board-events';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { ActivityService } from './activity.service';
import { toCard } from './card.mapper';

/** The workspace owner, or the board's creator for as long as they can still edit the workspace. */
const canManage = (role: WorkspaceRole, createdBy: string | null, userId: string): boolean =>
  role === 'owner' || (role === 'editor' && createdBy === userId);

@Injectable()
export class BoardsService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(WorkspaceAccessService) private readonly access: WorkspaceAccessService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(BoardEvents) private readonly events: BoardEvents,
  ) {}

  /** The whole board: columns and every live card, in display order. */
  async get(userId: string, boardId: string): Promise<BoardSnapshot> {
    const { role } = await this.access.requireForBoard(userId, boardId, 'viewer');
    const { db } = this.database;
    const [board] = await db
      .select()
      .from(boards)
      .where(and(eq(boards.id, boardId), isNull(boards.deletedAt)));
    if (!board) throw new AppError('not_found', 'Not found');

    const [columns, cardRows] = await Promise.all([
      db
        .select()
        .from(boardColumns)
        .where(eq(boardColumns.boardId, boardId))
        .orderBy(asc(boardColumns.position), asc(boardColumns.id)),
      db
        .select()
        .from(cards)
        .where(and(eq(cards.boardId, boardId), isNull(cards.deletedAt)))
        .orderBy(asc(cards.position), asc(cards.id)),
    ]);

    return {
      board: {
        id: board.id,
        workspaceId: board.workspaceId,
        name: board.name,
        canManage: canManage(role, board.createdBy, userId),
      },
      role,
      columns: columns.map(({ id, boardId: b, name, position }) => ({
        id,
        boardId: b,
        name,
        position,
      })),
      cards: cardRows.map(toCard),
    };
  }

  /** Owners and editors create boards; viewers only read. The columns are created with the board. */
  async create(user: AuthUser, workspaceId: string, body: CreateBoardBody): Promise<CreatedBoard> {
    await this.access.require(user.id, workspaceId, 'editor');
    const names = body.columns ?? [...DEFAULT_COLUMN_NAMES];
    return this.database.db.transaction(async (tx) => {
      const [board] = await tx
        .insert(boards)
        .values({ workspaceId, name: body.name, createdBy: user.id })
        .returning();
      if (!board) throw new Error('board insert returned nothing');
      const keys = evenlySpacedKeys(names.length);
      await tx
        .insert(boardColumns)
        .values(
          names.map((name, index) => ({ boardId: board.id, name, position: keys[index] ?? 'a0' })),
        );
      return { id: board.id, workspaceId, name: board.name };
    });
  }

  /** Rename or delete: workspace owners, and the board's creator while they are still an editor. */
  private async requireManage(user: AuthUser, boardId: string) {
    const { workspaceId, role } = await this.access.requireForBoard(user.id, boardId, 'viewer');
    const [board] = await this.database.db
      .select({ createdBy: boards.createdBy })
      .from(boards)
      .where(and(eq(boards.id, boardId), isNull(boards.deletedAt)));
    if (!board) throw new AppError('not_found', 'Not found');
    if (!canManage(role, board.createdBy, user.id))
      throw new AppError('forbidden', 'Only a workspace owner or the board creator can do this');
    return workspaceId;
  }

  async rename(user: AuthUser, boardId: string, body: RenameBoardBody): Promise<CreatedBoard> {
    const workspaceId = await this.requireManage(user, boardId);
    const [board] = await this.database.db
      .update(boards)
      .set({ name: body.name })
      .where(and(eq(boards.id, boardId), isNull(boards.deletedAt)))
      .returning();
    if (!board) throw new AppError('not_found', 'Not found');
    this.events.emit('board.renamed', { boardId, name: board.name });
    return { id: board.id, workspaceId, name: board.name };
  }

  /**
   * Soft delete. The board and all of its cards disappear for everyone at once (the cards are
   * marked deleted too, so search, comments and attachments stop seeing them and the worker
   * removes their files); the rows themselves stay for history.
   */
  async remove(user: AuthUser, boardId: string): Promise<void> {
    await this.requireManage(user, boardId);
    const now = new Date();
    const removed = await this.database.db.transaction(async (tx) => {
      const [board] = await tx
        .update(boards)
        .set({ deletedAt: now })
        .where(and(eq(boards.id, boardId), isNull(boards.deletedAt)))
        .returning({ id: boards.id });
      if (!board) return false;
      await tx
        .update(cards)
        .set({ deletedAt: now })
        .where(and(eq(cards.boardId, boardId), isNull(cards.deletedAt)));
      return true;
    });
    if (!removed) throw new AppError('not_found', 'Not found');
    this.events.emit('board.deleted', { boardId });
  }

  async createCard(user: AuthUser, boardId: string, body: CreateCardBody): Promise<Card> {
    const { workspaceId } = await this.access.requireForBoard(user.id, boardId, 'editor');

    const created = await this.database.db.transaction(async (tx) => {
      const result = await createCardInTx(tx, {
        workspaceId,
        boardId,
        columnId: body.columnId,
        title: body.title,
        description: body.description,
        createdBy: user.id,
        afterId: body.afterId,
        beforeId: body.beforeId,
      });
      if (!result.ok) throw new AppError('not_found', 'Column not found on this board');

      const eventId = await this.activity.record(tx, {
        workspaceId,
        boardId,
        actorId: user.id,
        type: 'card.created',
        entityType: 'card',
        entityId: result.card.id,
        payload: { title: result.card.title, columnId: result.card.columnId },
      });
      const positions = result.rebalanced ? await columnPositions(tx, body.columnId) : null;
      return { card: toCard(result.card), eventId, positions };
    });

    const envelope = {
      eventId: created.eventId,
      boardId,
      actorId: user.id,
      clientMutationId: body.clientMutationId ?? null,
    };
    this.events.emit('card.created', { ...envelope, card: created.card });
    if (created.positions)
      this.events.emit('column.rebalanced', {
        ...envelope,
        columnId: body.columnId,
        positions: created.positions,
      });
    return created.card;
  }
}
