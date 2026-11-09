import {
  loginBodySchema,
  registerBodySchema,
  type LoginBody,
  type Me,
  type RegisterBody,
} from '@kanban/shared';
import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Response } from 'express';

import { ZodBody } from '../common/swagger';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AppConfig } from '../config';
import { APP_CONFIG } from '../infra/tokens';
import { type AuthenticatedRequest, type AuthUser, SESSION_COOKIE } from './auth-user';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { Public } from './public.decorator';
import { SessionService } from './session.service';

@ApiTags('auth')
@Controller()
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private cookieOptions(): CookieOptions {
    return { httpOnly: true, sameSite: 'lax', secure: this.config.session.cookieSecure, path: '/' };
  }

  private startSession(response: Response, sessionId: string): void {
    response.cookie(SESSION_COOKIE, sessionId, {
      ...this.cookieOptions(),
      maxAge: this.config.session.ttlSeconds * 1000,
    });
  }

  @Public()
  @Post('auth/register')
  @ApiOperation({ summary: 'Create an account and sign in' })
  @ZodBody(registerBodySchema)
  async register(
    @Body(new ZodValidationPipe(registerBodySchema)) body: RegisterBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Me> {
    const { user, sessionId } = await this.auth.register(body);
    this.startSession(response, sessionId);
    return user;
  }

  @Public()
  @HttpCode(200)
  @Post('auth/login')
  @ApiOperation({ summary: 'Sign in' })
  @ZodBody(loginBodySchema)
  async login(
    @Body(new ZodValidationPipe(loginBodySchema)) body: LoginBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Me> {
    const { user, sessionId } = await this.auth.login(body.email, body.password);
    this.startSession(response, sessionId);
    return user;
  }

  /** Ends the session on the server (not just in the browser); works with or without one. */
  @Public()
  @HttpCode(204)
  @Post('auth/logout')
  @ApiOperation({ summary: 'Sign out' })
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    if (request.sessionId) await this.sessions.destroy(request.sessionId);
    response.clearCookie(SESSION_COOKIE, this.cookieOptions());
  }

  @Get('me')
  @ApiOperation({ summary: 'The signed-in user' })
  me(@CurrentUser() user: AuthUser): Me {
    return user;
  }
}
