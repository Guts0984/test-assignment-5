import type { Me } from '@kanban/shared';
import type { Request } from 'express';

export type AuthUser = Me;

export type AuthenticatedRequest = Request & {
  id?: string;
  user?: AuthUser;
  sessionId?: string;
};

export const SESSION_COOKIE = 'sid';
