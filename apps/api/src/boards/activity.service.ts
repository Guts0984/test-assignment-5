import { activityLog, users, type DatabaseHandle, type Transaction } from '@kanban/db';
import { LIMITS, type ActivityEntry, type ActivityPage, type ActivityType } from '@kanban/shared';
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt, and } from 'drizzle-orm';

import { AppError } from '../common/app-error';
import { DATABASE } from '../infra/tokens';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';

export type ActivityRecord = {
  workspaceId: string;
  boardId: string;
  actorId: string;
  type: ActivityType;
  entityType: 'card' | 'comment' | 'attachment';
  entityId: string;
  payload?: Record<string, unknown>;
};

const encodeCursor = (id: number): string => Buffer.from(String(id)).toString('base64url');
const decodeCursor = (cursor: string): number => {
  const id = Number(Buffer.from(cursor, 'base64url').toString());
  if (!Number.isSafeInteger(id) || id < 1)
    throw new AppError('validation_failed', 'Invalid cursor');
  return id;
};

@Injectable()
export class ActivityService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(WorkspaceAccessService) private readonly access: WorkspaceAccessService,
  ) {}

  /**
   * Appends to the board journal inside the caller's transaction, so a change and its journal
   * entry exist together or not at all. The returned id orders realtime events.
   */
  async record(tx: Transaction, entry: ActivityRecord): Promise<number> {
    const [row] = await tx
      .insert(activityLog)
      .values({ ...entry, payload: entry.payload ?? {} })
      .returning({ id: activityLog.id });
    if (!row) throw new Error('activity insert returned nothing');
    return row.id;
  }

  /** Newest first. The cursor is the id of the last entry already seen. */
  async list(
    userId: string,
    boardId: string,
    query: { cursor?: string; limit: number },
  ): Promise<ActivityPage> {
    await this.access.requireForBoard(userId, boardId, 'viewer');
    const limit = Math.min(query.limit, LIMITS.pageSize.max);
    const before = query.cursor ? decodeCursor(query.cursor) : undefined;

    const rows = await this.database.db
      .select({
        id: activityLog.id,
        type: activityLog.type,
        entityType: activityLog.entityType,
        entityId: activityLog.entityId,
        payload: activityLog.payload,
        createdAt: activityLog.createdAt,
        actorId: users.id,
        actorHandle: users.handle,
        actorName: users.name,
      })
      .from(activityLog)
      .leftJoin(users, eq(users.id, activityLog.actorId))
      .where(
        and(
          eq(activityLog.boardId, boardId),
          before === undefined ? undefined : lt(activityLog.id, before),
        ),
      )
      .orderBy(desc(activityLog.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const items = page.map((row): ActivityEntry => ({
      id: row.id,
      type: row.type as ActivityType,
      actor: row.actorId
        ? { id: row.actorId, handle: row.actorHandle ?? '', name: row.actorName ?? '' }
        : null,
      entityType: row.entityType as ActivityEntry['entityType'],
      entityId: row.entityId,
      payload: row.payload,
      createdAt: row.createdAt.toISOString(),
    }));
    const last = page.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.id) : null };
  }
}
