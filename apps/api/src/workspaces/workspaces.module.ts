import { Module } from '@nestjs/common';

import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';
import { MembersService } from './members.service';
import { MyInvitesController } from './my-invites.controller';
import { MembershipEvents } from './membership-events';
import { WorkspaceAccessService } from './workspace-access.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  controllers: [WorkspacesController, InvitesController, MyInvitesController],
  providers: [
    WorkspaceAccessService,
    WorkspacesService,
    InvitesService,
    MembersService,
    MembershipEvents,
  ],
  exports: [WorkspaceAccessService, MembershipEvents],
})
export class WorkspacesModule {}
