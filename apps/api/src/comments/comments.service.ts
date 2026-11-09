import {
  commentMentions,
  comments,
  users,
  workspaceMembers,
  type DatabaseHandle,
} from '@kanban/db';
import {
  extractMentions,
  type Comment,
  type CreateCommentBody,
  type UserRef,
} from '@kanban/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';

import type { AuthUser } from '../auth/auth-user';
import { ActivityService } from '../boards/activity.service';
import { DATABASE } from '../infra/tokens';
import { BoardEvents } from '../realtime/board-events';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';

const MAX_COMMENTS = 1_000;

@Injectable()
export class CommentsService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(WorkspaceAccessService) private readonly access: WorkspaceAccessService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(BoardEvents) private readonly events: BoardEvents,
  ) {}

  async list(userId: string, cardId: string): Promise<Comment[]> {
    await this.access.requireForCard(userId, cardId, 'viewer');
    const { db } = this.database;
    const rows = await db
      .select({
        id: comments.id,
        cardId: comments.cardId,
        body: comments.body,
        createdAt: comments.createdAt,
        authorId: users.id,
        authorHandle: users.handle,
        authorName: users.name,
      })
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(eq(comments.cardId, cardId))
      .orderBy(asc(comments.createdAt), asc(comments.id))
      .limit(MAX_COMMENTS);
    if (rows.length === 0) return [];

    const mentionRows = await db
      .select({
        commentId: commentMentions.commentId,
        id: users.id,
        handle: users.handle,
        name: users.name,
      })
      .from(commentMentions)
      .innerJoin(users, eq(users.id, commentMentions.userId))
      .where(
        inArray(
          commentMentions.commentId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(users.handle));

    return rows.map((row) => ({
      id: row.id,
      cardId: row.cardId,
      author: { id: row.authorId, handle: row.authorHandle, name: row.authorName },
      body: row.body,
      mentions: mentionRows
        .filter((mention) => mention.commentId === row.id)
        .map(({ id, handle, name }): UserRef => ({ id, handle, name })),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Stores the comment and one mention row per mentioned workspace member (never the author, and
   * never someone outside the workspace). The mention rows are what the worker later turns into a
   * digest email, so they are written in the same transaction as the comment.
   */
  async create(user: AuthUser, cardId: string, body: CreateCommentBody): Promise<Comment> {
    const ref = await this.access.requireForCard(user.id, cardId, 'editor');
    const handles = extractMentions(body.body);

    const created = await this.database.db.transaction(async (tx) => {
      const [comment] = await tx
        .insert(comments)
        .values({ workspaceId: ref.workspaceId, cardId, authorId: user.id, body: body.body })
        .returning();
      if (!comment) throw new Error('comment insert returned nothing');

      const mentioned: UserRef[] =
        handles.length === 0
          ? []
          : (
              await tx
                .select({ id: users.id, handle: users.handle, name: users.name })
                .from(users)
                .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
                .where(
                  and(
                    eq(workspaceMembers.workspaceId, ref.workspaceId),
                    inArray(users.handle, handles),
                  ),
                )
            ).filter((person) => person.id !== user.id);
      if (mentioned.length > 0) {
        await tx
          .insert(commentMentions)
          .values(mentioned.map((person) => ({ commentId: comment.id, userId: person.id })));
      }

      const eventId = await this.activity.record(tx, {
        workspaceId: ref.workspaceId,
        boardId: ref.boardId,
        actorId: user.id,
        type: 'comment.created',
        entityType: 'comment',
        entityId: comment.id,
        payload: { cardId, mentions: mentioned.map((person) => person.handle) },
      });
      const result: Comment = {
        id: comment.id,
        cardId,
        author: { id: user.id, handle: user.handle, name: user.name },
        body: comment.body,
        mentions: mentioned.sort((a, b) => a.handle.localeCompare(b.handle)),
        createdAt: comment.createdAt.toISOString(),
      };
      return { result, eventId };
    });

    this.events.emit('comment.created', {
      eventId: created.eventId,
      boardId: ref.boardId,
      actorId: user.id,
      clientMutationId: null,
      comment: created.result,
    });
    return created.result;
  }
}
