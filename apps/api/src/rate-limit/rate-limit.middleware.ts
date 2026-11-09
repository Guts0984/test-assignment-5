import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../common/app-error';
import type { AppConfig } from '../config';
import { clientIpOf } from './client-ip';
import type { RateLimiter } from './rate-limiter';

const WINDOW_MS = 60_000;
const EXEMPT = new Set(['/health', '/ready']);

/** Per-IP limit shared by all instances; sign-in and registration get a much stricter one. */
export const rateLimitMiddleware =
  (limiter: RateLimiter, config: AppConfig) =>
  async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    if (EXEMPT.has(request.path)) return next();

    const strict = request.path.startsWith('/auth/');
    const limit = strict ? config.rateLimit.authPerMinute : config.rateLimit.perMinute;
    const ip = await clientIpOf(
      request.headers,
      request.socket.remoteAddress,
      config.clientIpSecret,
    );
    const result = await limiter.hit(`rl:${strict ? 'auth' : 'api'}:${ip}`, limit, WINDOW_MS);

    response.setHeader('RateLimit-Limit', String(limit));
    response.setHeader('RateLimit-Remaining', String(Math.max(0, limit - result.count)));
    if (!result.allowed) {
      response.setHeader('Retry-After', String(result.retryAfterSeconds));
      throw new AppError('rate_limited', 'Too many requests, slow down', {
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
    next();
  };
