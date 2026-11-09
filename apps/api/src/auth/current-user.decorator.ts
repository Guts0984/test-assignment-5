import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import { AppError } from '../common/app-error';
import type { AuthUser, AuthenticatedRequest } from './auth-user';

/** The signed-in user. Only valid on routes that are not `@Public()`. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser => {
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!user) throw new AppError('unauthorized', 'Sign in required');
    return user;
  },
);
