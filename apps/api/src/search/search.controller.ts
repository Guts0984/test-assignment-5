import { searchQuerySchema, type SearchPage, type SearchQuery } from '@kanban/shared';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SearchService } from './search.service';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(@Inject(SearchService) private readonly search: SearchService) {}

  @Get()
  @ApiOperation({
    summary: 'Ranked, highlighted full-text search over cards and comments of a workspace',
  })
  run(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQuery,
  ): Promise<SearchPage> {
    return this.search.search(user.id, query);
  }
}
