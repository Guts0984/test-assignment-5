import {
  createCardBodySchema,
  idSchema,
  pageQuerySchema,
  renameBoardBodySchema,
  type ActivityPage,
  type BoardSnapshot,
  type Card,
  type CreatedBoard,
  type CreateCardBody,
  type RenameBoardBody,
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
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';

import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { ZodBody } from '../common/swagger';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ActivityService } from './activity.service';
import { BoardsService } from './boards.service';

@ApiTags('boards')
@Controller('boards')
export class BoardsController {
  constructor(
    @Inject(BoardsService) private readonly boards: BoardsService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'The whole board: columns and cards' })
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
  ): Promise<BoardSnapshot> {
    return this.boards.get(user.id, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Rename a board (workspace owner, or the board creator while an editor)',
  })
  @ZodBody(renameBoardBodySchema)
  rename(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(renameBoardBodySchema)) body: RenameBoardBody,
  ): Promise<CreatedBoard> {
    return this.boards.rename(user, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a board (workspace owner, or the board creator while an editor)',
  })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
  ): Promise<void> {
    await this.boards.remove(user, id);
  }

  @Post(':id/cards')
  @ApiOperation({ summary: 'Create a card (editor or owner)' })
  @ZodBody(createCardBodySchema)
  createCard(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(createCardBodySchema)) body: CreateCardBody,
  ): Promise<Card> {
    return this.boards.createCard(user, id, body);
  }

  @Get(':id/activity')
  @ApiOperation({ summary: 'Change log of the board, newest first, cursor-paginated' })
  activityLog(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Query(new ZodValidationPipe(pageQuerySchema)) query: z.infer<typeof pageQuerySchema>,
  ): Promise<ActivityPage> {
    return this.activity.list(user.id, id, query);
  }
}
