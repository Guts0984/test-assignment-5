import {
  boardColumns,
  boards,
  cards,
  columnPositions,
  createCardInTx,
  type DatabaseHandle,
} from '@kanban/db';
import type { BoardSnapshot, Card, CreateCardBody } from '@kanban/shared';
import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, and, isNull } from 'drizzle-orm';

import type { AuthUser } from '../auth/auth-user';
import { AppError } from '../common/app-error';
import { DATABASE } from '../infra/tokens';
import { BoardEvents } from '../realtime/board-events';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { ActivityService } from './activity.service';
import { toCard } from './card.mapper';

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
    const [board] = await db.select().from(boards).where(eq(boards.id, boardId));
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
      board: { id: board.id, workspaceId: board.workspaceId, name: board.name },
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
