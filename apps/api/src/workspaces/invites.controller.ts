import type { InvitePreview } from '@kanban/shared';
import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import { InvitesService } from './invites.service';

@ApiTags('invites')
@Controller('invites')
export class InvitesController {
  constructor(@Inject(InvitesService) private readonly invites: InvitesService) {}

  @Public()
  @Get(':token')
  @ApiOperation({ summary: 'What an invitation is for (the link itself is the credential)' })
  preview(@Param('token') token: string): Promise<InvitePreview> {
    return this.invites.preview(token);
  }

  @HttpCode(200)
  @Post(':token/accept')
  @ApiOperation({ summary: 'Accept an invitation with the account that owns the invited email' })
  accept(@CurrentUser() user: AuthUser, @Param('token') token: string) {
    return this.invites.accept(user, token);
  }
}
