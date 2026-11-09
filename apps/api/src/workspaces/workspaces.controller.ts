import {
  createInviteBodySchema,
  idSchema,
  updateMemberBodySchema,
  type CreateInviteBody,
  type Invite,
  type Member,
  type UpdateMemberBody,
  type WorkspaceSummary,
} from '@kanban/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { ZodBody } from '../common/swagger';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { InvitesService } from './invites.service';
import { MembersService } from './members.service';
import { WorkspacesService } from './workspaces.service';

const id = new ZodValidationPipe(idSchema);

@ApiTags('workspaces')
@Controller('workspaces')
export class WorkspacesController {
  constructor(
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
    @Inject(InvitesService) private readonly invites: InvitesService,
    @Inject(MembersService) private readonly members: MembersService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'My workspaces, my role in each, and their boards' })
  list(@CurrentUser() user: AuthUser): Promise<WorkspaceSummary[]> {
    return this.workspaces.listFor(user.id);
  }

  @Get(':id/members')
  @ApiOperation({ summary: 'Members of a workspace (any member)' })
  listMembers(
    @CurrentUser() user: AuthUser,
    @Param('id', id) workspaceId: string,
  ): Promise<Member[]> {
    return this.workspaces.members(user.id, workspaceId);
  }

  @Post(':id/invites')
  @ApiOperation({ summary: 'Invite someone by email (owner only)' })
  @ZodBody(createInviteBodySchema)
  invite(
    @CurrentUser() user: AuthUser,
    @Param('id', id) workspaceId: string,
    @Body(new ZodValidationPipe(createInviteBodySchema)) body: CreateInviteBody,
  ): Promise<Invite> {
    return this.invites.create(user, workspaceId, body);
  }

  @Patch(':id/members/:userId')
  @ApiOperation({ summary: 'Change a member role (owner only)' })
  @ZodBody(updateMemberBodySchema)
  async changeRole(
    @CurrentUser() user: AuthUser,
    @Param('id', id) workspaceId: string,
    @Param('userId', id) targetId: string,
    @Body(new ZodValidationPipe(updateMemberBodySchema)) body: UpdateMemberBody,
  ): Promise<{ userId: string; role: UpdateMemberBody['role'] }> {
    await this.members.changeRole(user.id, workspaceId, targetId, body.role);
    return { userId: targetId, role: body.role };
  }

  @Delete(':id/members/:userId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a member (owner only)' })
  async removeMember(
    @CurrentUser() user: AuthUser,
    @Param('id', id) workspaceId: string,
    @Param('userId', id) targetId: string,
  ): Promise<void> {
    await this.members.remove(user.id, workspaceId, targetId);
  }
}
