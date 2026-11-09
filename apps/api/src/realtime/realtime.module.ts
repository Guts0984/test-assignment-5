import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BoardsModule } from '../boards/boards.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { PresenceService } from './presence.service';
import { RealtimeService } from './realtime.service';

@Module({
  imports: [AuthModule, WorkspacesModule, BoardsModule],
  providers: [PresenceService, RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
