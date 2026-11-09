import { Module } from '@nestjs/common';

import { BoardsModule } from '../boards/boards.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

@Module({
  imports: [WorkspacesModule, BoardsModule],
  controllers: [CommentsController],
  providers: [CommentsService],
})
export class CommentsModule {}
