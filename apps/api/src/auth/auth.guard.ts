import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppError } from '../common/app-error';
import { type AuthenticatedRequest, SESSION_COOKIE } from './auth-user';
import { IS_PUBLIC } from './public.decorator';
import { SessionService } from './session.service';

/** Reads the `Cookie` header without a dependency; unparsable values are simply ignored. */
export const readCookie = (header: string | undefined, name: string): string | undefined => {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
};

/**
 * Global guard: every route requires a valid session unless marked `@Public()`. A session is
 * attached even on public routes when present, so `logout` can end it.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const sessionId = readCookie(request.headers.cookie, SESSION_COOKIE);
    const user = sessionId ? await this.sessions.resolve(sessionId) : null;
    if (user && sessionId) {
      request.user = user;
      request.sessionId = sessionId;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!user && !isPublic) throw new AppError('unauthorized', 'Sign in required');
    return true;
  }
}
