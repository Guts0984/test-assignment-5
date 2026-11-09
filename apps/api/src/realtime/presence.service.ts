import { type PresenceUser, type UserRef } from '@kanban/shared';
import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';

import { REDIS } from '../infra/tokens';

/** A silent client is forgotten this long after its last heartbeat (clients beat every 2 s). */
export const PRESENCE_TTL_MS = 6_000;

type Entry = { user: UserRef; editingCardId: string | null };

/**
 * Who is on which board, shared by every API instance through Redis.
 *  - one entry per connection (socket id), so closing one of two tabs keeps the user listed;
 *  - every entry carries an expiry that heartbeats keep pushing forward, so a client that
 *    vanished without a clean disconnect (crash, network loss, a killed API instance) drops out
 *    on its own within PRESENCE_TTL_MS.
 */
@Injectable()
export class PresenceService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private zset = (boardId: string) => `presence:${boardId}`;
  private hash = (boardId: string) => `presence:data:${boardId}`;

  async touch(boardId: string, socketId: string, entry: Entry): Promise<void> {
    await this.redis
      .multi()
      .zadd(this.zset(boardId), Date.now() + PRESENCE_TTL_MS, socketId)
      .hset(this.hash(boardId), socketId, JSON.stringify(entry))
      .pexpire(this.zset(boardId), PRESENCE_TTL_MS * 10)
      .pexpire(this.hash(boardId), PRESENCE_TTL_MS * 10)
      .exec();
  }

  async remove(boardId: string, socketId: string): Promise<void> {
    await this.redis
      .multi()
      .zrem(this.zset(boardId), socketId)
      .hdel(this.hash(boardId), socketId)
      .exec();
  }

  /** The current list; expired entries are purged as a side effect. */
  async snapshot(boardId: string): Promise<PresenceUser[]> {
    const expired = await this.redis.zrangebyscore(this.zset(boardId), '-inf', Date.now());
    if (expired.length > 0) {
      await this.redis
        .multi()
        .zrem(this.zset(boardId), ...expired)
        .hdel(this.hash(boardId), ...expired)
        .exec();
    }
    const sockets = await this.redis.zrange(this.zset(boardId), '0', '-1');
    if (sockets.length === 0) return [];
    const raw = await this.redis.hmget(this.hash(boardId), ...sockets);

    const byUser = new Map<string, PresenceUser>();
    for (const item of raw) {
      if (!item) continue;
      const entry = JSON.parse(item) as Entry;
      const existing = byUser.get(entry.user.id);
      if (!existing)
        byUser.set(entry.user.id, { user: entry.user, editingCardId: entry.editingCardId });
      else if (!existing.editingCardId && entry.editingCardId)
        existing.editingCardId = entry.editingCardId;
    }
    return [...byUser.values()].sort((a, b) => a.user.handle.localeCompare(b.user.handle));
  }
}
