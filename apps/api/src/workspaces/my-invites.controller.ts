import { idSchema, type MyInvite } from '@kanban/shared';
import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { InvitesService } from './invites.service';

@ApiTags('invites')
@Controller('me/invites')
export class MyInvitesController {
  constructor(@Inject(InvitesService) private readonly invites: InvitesService) {}

  @Get()
  @ApiOperation({ summary: 'Open invitations addressed to my email, to accept inside the app' })
  list(@CurrentUser() user: AuthUser): Promise<MyInvite[]> {
    return this.invites.listMine(user);
  }

  @HttpCode(200)
  @Post(':id/accept')
  @ApiOperation({ summary: 'Accept one of my own invitations without the emailed link' })
  accept(@CurrentUser() user: AuthUser, @Param('id', new ZodValidationPipe(idSchema)) id: string) {
    return this.invites.acceptMine(user, id);
  }
}
