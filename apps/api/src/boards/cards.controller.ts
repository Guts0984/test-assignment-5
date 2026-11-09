import {
  idSchema,
  moveCardBodySchema,
  updateCardBodySchema,
  type Card,
  type MoveCardBody,
  type MoveCardResponse,
  type UpdateCardBody,
} from '@kanban/shared';
import { Body, Controller, Delete, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { ZodBody } from '../common/swagger';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CardsService } from './cards.service';

const id = new ZodValidationPipe(idSchema);

@ApiTags('cards')
@Controller('cards')
export class CardsController {
  constructor(@Inject(CardsService) private readonly cards: CardsService) {}

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a card; 409 with the current card if its version is stale' })
  @ZodBody(updateCardBodySchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', id) cardId: string,
    @Body(new ZodValidationPipe(updateCardBodySchema)) body: UpdateCardBody,
  ): Promise<Card> {
    return this.cards.update(user, cardId, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a card (editor or owner)' })
  async remove(@CurrentUser() user: AuthUser, @Param('id', id) cardId: string): Promise<void> {
    await this.cards.delete(user, cardId);
  }

  @Post(':id/move')
  @HttpCode(200)
  @ApiOperation({ summary: 'Move a card between two neighbours, possibly into another column' })
  @ZodBody(moveCardBodySchema)
  move(
    @CurrentUser() user: AuthUser,
    @Param('id', id) cardId: string,
    @Body(new ZodValidationPipe(moveCardBodySchema)) body: MoveCardBody,
  ): Promise<MoveCardResponse> {
    return this.cards.move(user, cardId, body);
  }
}
