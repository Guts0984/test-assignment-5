import { Module } from '@nestjs/common';

import { WorkspacesModule } from '../workspaces/workspaces.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  imports: [WorkspacesModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
