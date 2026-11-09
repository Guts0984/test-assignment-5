import { Module } from '@nestjs/common';

import { BoardEvents } from '../realtime/board-events';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ActivityService } from './activity.service';
import { BoardsController } from './boards.controller';
import { BoardsService } from './boards.service';
import { CardsController } from './cards.controller';
import { CardsService } from './cards.service';

@Module({
  imports: [WorkspacesModule],
  controllers: [BoardsController, CardsController],
  providers: [BoardsService, CardsService, ActivityService, BoardEvents],
  exports: [ActivityService, BoardEvents, BoardsService],
})
export class BoardsModule {}
