import {
  createAttachmentBodySchema,
  idSchema,
  type Attachment,
  type CreateAttachmentBody,
  type CreateAttachmentResponse,
  type DownloadLink,
} from '@kanban/shared';
import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { ZodBody } from '../common/swagger';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AttachmentsService } from './attachments.service';

const id = new ZodValidationPipe(idSchema);

@ApiTags('attachments')
@Controller()
export class AttachmentsController {
  constructor(@Inject(AttachmentsService) private readonly attachments: AttachmentsService) {}

  @Post('cards/:id/attachments')
  @ApiOperation({
    summary: 'Register an upload; returns a signed form for sending the file to storage',
  })
  @ZodBody(createAttachmentBodySchema)
  create(
    @CurrentUser() user: AuthUser,
    @Param('id', id) cardId: string,
    @Body(new ZodValidationPipe(createAttachmentBodySchema)) body: CreateAttachmentBody,
  ): Promise<CreateAttachmentResponse> {
    return this.attachments.create(user, cardId, body);
  }

  @Get('cards/:id/attachments')
  @ApiOperation({ summary: 'Completed attachments of a card' })
  list(@CurrentUser() user: AuthUser, @Param('id', id) cardId: string): Promise<Attachment[]> {
    return this.attachments.list(user.id, cardId);
  }

  @Post('attachments/:id/complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm an upload; the file type is checked from its content' })
  complete(
    @CurrentUser() user: AuthUser,
    @Param('id', id) attachmentId: string,
  ): Promise<Attachment> {
    return this.attachments.complete(user, attachmentId);
  }

  @Get('attachments/:id/download')
  @ApiOperation({ summary: 'A signed download link that is valid for five minutes' })
  download(
    @CurrentUser() user: AuthUser,
    @Param('id', id) attachmentId: string,
  ): Promise<DownloadLink> {
    return this.attachments.downloadLink(user.id, attachmentId);
  }
}
