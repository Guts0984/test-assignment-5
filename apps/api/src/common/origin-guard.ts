import type { NextFunction, Request, Response } from 'express';

import { AppError } from './app-error';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Second line of defence against cross-site request forgery, next to `SameSite=Lax` cookies:
 * a browser always sends `Origin` on cross-site writes, and anything other than our own origin
 * is refused. Requests without `Origin` (server-to-server calls from Next.js, curl) pass; they
 * cannot be driven by a victim's browser.
 */
export const originGuard =
  (allowedOrigin: string) =>
  (request: Request, _response: Response, next: NextFunction): void => {
    const origin = request.header('origin');
    if (!SAFE_METHODS.has(request.method) && origin !== undefined && origin !== allowedOrigin) {
      throw new AppError('forbidden', 'Cross-site request refused');
    }
    next();
  };
