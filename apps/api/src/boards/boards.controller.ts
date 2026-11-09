import {
  createCardBodySchema,
  idSchema,
  pageQuerySchema,
  type ActivityPage,
  type BoardSnapshot,
  type Card,
  type CreateCardBody,
} from '@kanban/shared';
import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
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
