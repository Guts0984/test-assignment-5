import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { REDIS } from '../infra/tokens';

export type RateLimitResult = { allowed: boolean; count: number; retryAfterSeconds: number };

// Atomic fixed-window counter shared by every API instance through Redis.
const SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {count, ttl}
`;

@Injectable()
export class RateLimiter {
  private readonly logger = new Logger(RateLimiter.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * Counts a hit for `key`. If Redis is unavailable the request is allowed (fail open): a
   * broken limiter must not take the whole API down with it.
   */
  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    try {
      const reply = await this.redis.eval(SCRIPT, 1, key, String(windowMs));
      if (!Array.isArray(reply) || typeof reply[0] !== 'number' || typeof reply[1] !== 'number') {
        throw new Error('unexpected reply from rate limit script');
      }
      const [count, ttl] = reply as [number, number];
      return {
        allowed: count <= limit,
        count,
        retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1000)),
      };
    } catch (error) {
      this.logger.warn(
        `rate limiter unavailable, allowing request: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { allowed: true, count: 0, retryAfterSeconds: 1 };
    }
  }
}
