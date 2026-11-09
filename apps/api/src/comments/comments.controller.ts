import {
  createCommentBodySchema,
  idSchema,
  type Comment,
  type CreateCommentBody,
} from '@kanban/shared';
import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { ZodBody } from '../common/swagger';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CommentsService } from './comments.service';

@ApiTags('comments')
@Controller('cards/:id/comments')
export class CommentsController {
  constructor(@Inject(CommentsService) private readonly comments: CommentsService) {}

  @Get()
  @ApiOperation({ summary: 'Comments of a card, oldest first' })
  list(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(idSchema)) cardId: string,
  ): Promise<Comment[]> {
    return this.comments.list(user.id, cardId);
  }

  @Post()
  @ApiOperation({ summary: 'Add a comment; @handle mentions notify workspace members' })
  @ZodBody(createCommentBodySchema)
  create(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(idSchema)) cardId: string,
    @Body(new ZodValidationPipe(createCommentBodySchema)) body: CreateCommentBody,
  ): Promise<Comment> {
    return this.comments.create(user, cardId, body);
  }
}
