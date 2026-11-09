import {
  createBoardBodySchema,
  idSchema,
  type CreateBoardBody,
  type CreatedBoard,
} from '@kanban/shared';
import { Body, Controller, Inject, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { ZodBody } from '../common/swagger';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { BoardsService } from './boards.service';

@ApiTags('boards')
@Controller('workspaces/:id/boards')
export class WorkspaceBoardsController {
  constructor(@Inject(BoardsService) private readonly boards: BoardsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a board with its columns (editor or owner)' })
  @ZodBody(createBoardBodySchema)
  create(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(idSchema)) workspaceId: string,
    @Body(new ZodValidationPipe(createBoardBodySchema)) body: CreateBoardBody,
  ): Promise<CreatedBoard> {
    return this.boards.create(user, workspaceId, body);
  }
}
