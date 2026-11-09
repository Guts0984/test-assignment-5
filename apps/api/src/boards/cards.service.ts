import { cards, columnPositions, moveCardInTx, type DatabaseHandle } from '@kanban/db';
import type { Card, MoveCardBody, MoveCardResponse, UpdateCardBody } from '@kanban/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { AuthUser } from '../auth/auth-user';
import { AppError } from '../common/app-error';
import { DATABASE } from '../infra/tokens';
import { BoardEvents } from '../realtime/board-events';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { ActivityService } from './activity.service';
import { toCard } from './card.mapper';

@Injectable()
export class CardsService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(WorkspaceAccessService) private readonly access: WorkspaceAccessService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(BoardEvents) private readonly events: BoardEvents,
  ) {}

  /**
   * Edits title / description with optimistic locking: the update only happens if the card is
   * still at the version the editor started from. Otherwise the answer is 409 carrying the
   * current card, so the UI can show what the other person saved without losing the editor's text.
   */
  async update(user: AuthUser, cardId: string, body: UpdateCardBody): Promise<Card> {
    const ref = await this.access.requireForCard(user.id, cardId, 'editor');

    const outcome = await this.database.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(cards)
        .set({
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.description === undefined ? {} : { description: body.description }),
          version: sql`${cards.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(cards.id, cardId), eq(cards.version, body.version), isNull(cards.deletedAt)))
        .returning();

      if (!updated) {
        const [current] = await tx
          .select()
          .from(cards)
          .where(and(eq(cards.id, cardId), isNull(cards.deletedAt)));
        return { conflict: current ? toCard(current) : null };
      }
      const eventId = await this.activity.record(tx, {
        workspaceId: ref.workspaceId,
        boardId: ref.boardId,
        actorId: user.id,
        type: 'card.updated',
        entityType: 'card',
        entityId: cardId,
        payload: {
          fields: [
            body.title === undefined ? null : 'title',
            body.description === undefined ? null : 'description',
          ].filter(Boolean),
        },
      });
      return { card: toCard(updated), eventId };
    });

    if ('conflict' in outcome) {
      if (!outcome.conflict) throw new AppError('not_found', 'Not found');
      throw new AppError('version_conflict', 'This card was changed by someone else', {
        current: outcome.conflict,
      });
    }
    this.events.emit('card.updated', {
      eventId: outcome.eventId,
      boardId: ref.boardId,
      actorId: user.id,
      clientMutationId: body.clientMutationId ?? null,
      card: outcome.card,
    });
    return outcome.card;
  }

  async delete(user: AuthUser, cardId: string): Promise<void> {
    const ref = await this.access.requireForCard(user.id, cardId, 'editor');

    const eventId = await this.database.db.transaction(async (tx) => {
      const [deleted] = await tx
        .update(cards)
        .set({ deletedAt: new Date(), version: sql`${cards.version} + 1`, updatedAt: new Date() })
        .where(and(eq(cards.id, cardId), isNull(cards.deletedAt)))
        .returning({ title: cards.title });
      if (!deleted) throw new AppError('not_found', 'Not found'); // deleted by someone else a moment ago
      return this.activity.record(tx, {
        workspaceId: ref.workspaceId,
        boardId: ref.boardId,
        actorId: user.id,
        type: 'card.deleted',
        entityType: 'card',
        entityId: cardId,
        payload: { title: deleted.title, columnId: ref.columnId },
      });
    });

    this.events.emit('card.deleted', {
      eventId,
      boardId: ref.boardId,
      actorId: user.id,
      clientMutationId: null,
      cardId,
      columnId: ref.columnId,
    });
  }

  async move(user: AuthUser, cardId: string, body: MoveCardBody): Promise<MoveCardResponse> {
    const ref = await this.access.requireForCard(user.id, cardId, 'editor');

    const moved = await this.database.db.transaction(async (tx) => {
      const result = await moveCardInTx(tx, {
        cardId,
        columnId: body.columnId,
        afterId: body.afterId,
        beforeId: body.beforeId,
      });
      if (!result.ok)
        throw new AppError(
          'not_found',
          result.reason === 'column_not_found' ? 'Column not found on this board' : 'Not found',
        );

      const [row] = await tx.select().from(cards).where(eq(cards.id, cardId));
      if (!row) throw new AppError('not_found', 'Not found');
      const eventId = await this.activity.record(tx, {
        workspaceId: ref.workspaceId,
        boardId: ref.boardId,
        actorId: user.id,
        type: 'card.moved',
        entityType: 'card',
        entityId: cardId,
        payload: { fromColumnId: result.fromColumnId, columnId: result.columnId },
      });
      const positions = result.rebalanced ? await columnPositions(tx, body.columnId) : null;
      return {
        card: toCard(row),
        fromColumnId: result.fromColumnId,
        rebalanced: result.rebalanced,
        eventId,
        positions,
      };
    });

    const envelope = {
      eventId: moved.eventId,
      boardId: ref.boardId,
      actorId: user.id,
      clientMutationId: body.clientMutationId ?? null,
    };
    this.events.emit('card.moved', {
      ...envelope,
      card: moved.card,
      fromColumnId: moved.fromColumnId,
    });
    if (moved.positions)
      this.events.emit('column.rebalanced', {
        ...envelope,
        columnId: body.columnId,
        positions: moved.positions,
      });
    return {
      card: moved.card,
      eventId: moved.eventId,
      fromColumnId: moved.fromColumnId,
      rebalanced: moved.rebalanced,
    };
  }
}
