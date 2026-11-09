import { randomBytes } from 'node:crypto';

import { meSchema } from '@kanban/shared';
import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';

import type { AppConfig } from '../config';
import { APP_CONFIG, REDIS } from '../infra/tokens';
import type { AuthUser } from './auth-user';

const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;
const keyOf = (sessionId: string) => `sess:${sessionId}`;

/**
 * Server-side sessions in Redis. The cookie holds only a random id; everything else stays on
 * the server, so a session can be ended instantly and nothing in the cookie can be tampered with.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(user: AuthUser): Promise<string> {
    const id = randomBytes(32).toString('base64url');
    await this.redis.set(keyOf(id), JSON.stringify(user), 'EX', this.config.session.ttlSeconds);
    return id;
  }

  /**
   * Returns the user of a session and extends its life (sliding expiry), or null if the id is
   * unknown, expired or malformed. If Redis itself fails the error propagates (a 503), so an
   * outage never looks like "you were signed out".
   */
  async resolve(sessionId: string): Promise<AuthUser | null> {
    if (!SESSION_ID.test(sessionId)) return null;
    const raw = await this.redis.getex(keyOf(sessionId), 'EX', this.config.session.ttlSeconds);
    if (raw === null) return null;
    try {
      const parsed = meSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async destroy(sessionId: string): Promise<void> {
    if (SESSION_ID.test(sessionId)) await this.redis.del(keyOf(sessionId));
  }
}
