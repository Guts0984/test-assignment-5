import { randomUUID } from 'node:crypto';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { attachments, type DatabaseHandle } from '@kanban/db';
import {
  ALLOWED_CONTENT_TYPES,
  LIMITS,
  type Attachment,
  type CreateAttachmentBody,
  type CreateAttachmentResponse,
  type DownloadLink,
} from '@kanban/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { fileTypeFromBuffer } from 'file-type';

import type { AuthUser } from '../auth/auth-user';
import { ActivityService } from '../boards/activity.service';
import { AppError } from '../common/app-error';
import type { AppConfig } from '../config';
import { APP_CONFIG, DATABASE, S3, S3_SIGNER } from '../infra/tokens';
import { BoardEvents } from '../realtime/board-events';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';

const UPLOAD_WINDOW_SECONDS = 600;
/** Enough bytes for every format we accept to reveal its signature. */
const SNIFF_BYTES = 4_100;

const toAttachment = (row: typeof attachments.$inferSelect): Attachment => ({
  id: row.id,
  cardId: row.cardId,
  fileName: row.fileName,
  contentType: row.detectedType ?? row.declaredType,
  sizeBytes: row.sizeBytes,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
});

/** A file name that is safe inside a Content-Disposition header. */
const asciiFallback = (name: string): string =>
  name.replace(/[^\w.\- ()]/g, '_').slice(0, 100) || 'download';

/**
 * The `filename*` parameter (RFC 5987 / 8187) allows only letters, digits and !#$&+-.^_`|~ unescaped.
 * encodeURIComponent also leaves ' ( ) * alone, which that syntax does not allow.
 */
const encodeFilenameStar = (name: string): string =>
  encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(S3) private readonly s3: S3Client,
    @Inject(S3_SIGNER) private readonly signer: S3Client,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WorkspaceAccessService) private readonly access: WorkspaceAccessService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(BoardEvents) private readonly events: BoardEvents,
  ) {}

  /**
   * Step 1: register the upload. The browser then sends the file straight to object storage with
   * the returned form; storage itself enforces the size limit and the declared content type.
   * The row stays `pending` (and the worker removes it after an hour) until `complete`.
   */
  async create(
    user: AuthUser,
    cardId: string,
    body: CreateAttachmentBody,
  ): Promise<CreateAttachmentResponse> {
    const ref = await this.access.requireForCard(user.id, cardId, 'editor');
    const id = randomUUID();
    const objectKey = `${ref.workspaceId}/${cardId}/${id}`;

    const [row] = await this.database.db
      .insert(attachments)
      .values({
        id,
        workspaceId: ref.workspaceId,
        cardId,
        uploaderId: user.id,
        objectKey,
        fileName: body.fileName,
        declaredType: body.contentType,
        sizeBytes: body.sizeBytes,
      })
      .returning();
    if (!row) throw new Error('attachment insert returned nothing');

    const post = await createPresignedPost(this.s3, {
      Bucket: this.config.s3.bucket,
      Key: objectKey,
      Expires: UPLOAD_WINDOW_SECONDS,
      Conditions: [
        ['content-length-range', 1, body.sizeBytes],
        ['eq', '$Content-Type', body.contentType],
      ],
      Fields: { 'Content-Type': body.contentType },
    });

    return {
      attachment: toAttachment(row),
      // The form is signed for object storage, not for a host name, so the address can be swapped
      // for the one browsers use (nginx proxies it to storage).
      upload: {
        url: `${this.config.s3.publicUrl.replace(/\/$/, '')}/${this.config.s3.bucket}`,
        fields: post.fields,
      },
    };
  }

  /**
   * Step 2: verify what was actually uploaded. The type is decided from the file's own bytes,
   * never from its name or the declared type; anything that is not an image or a PDF is deleted.
   */
  async complete(user: AuthUser, attachmentId: string): Promise<Attachment> {
    const ref = await this.access.requireForAttachment(user.id, attachmentId, 'editor');
    const [row] = await this.database.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, attachmentId));
    if (!row) throw new AppError('not_found', 'Not found');
    if (row.status === 'ready') return toAttachment(row);

    const Bucket = this.config.s3.bucket;
    let size: number;
    try {
      const head = await this.s3.send(new HeadObjectCommand({ Bucket, Key: row.objectKey }));
      size = head.ContentLength ?? 0;
    } catch (error) {
      if (
        (error as { name?: string }).name === 'NotFound' ||
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
      ) {
        throw new AppError('conflict', 'The file has not been uploaded yet');
      }
      throw error;
    }
    if (size < 1 || size > LIMITS.attachmentBytes) {
      await this.discard(row);
      throw new AppError('payload_too_large', 'The file is larger than the 10 MB limit');
    }

    const head = await this.s3.send(
      new GetObjectCommand({ Bucket, Key: row.objectKey, Range: `bytes=0-${SNIFF_BYTES - 1}` }),
    );
    const bytes = (await head.Body?.transformToByteArray()) ?? new Uint8Array();
    const detected = await fileTypeFromBuffer(bytes);
    if (!detected || !(ALLOWED_CONTENT_TYPES as readonly string[]).includes(detected.mime)) {
      await this.discard(row);
      throw new AppError(
        'unsupported_media_type',
        'Only images (PNG, JPEG, GIF, WebP) and PDF files are accepted',
      );
    }

    const outcome = await this.database.db.transaction(async (tx) => {
      const [ready] = await tx
        .update(attachments)
        .set({
          status: 'ready',
          detectedType: detected.mime,
          sizeBytes: size,
          completedAt: new Date(),
        })
        .where(and(eq(attachments.id, attachmentId), eq(attachments.status, 'pending')))
        .returning();
      if (!ready) return null; // someone else completed it a moment ago
      const eventId = await this.activity.record(tx, {
        workspaceId: ref.workspaceId,
        boardId: ref.boardId,
        actorId: user.id,
        type: 'attachment.added',
        entityType: 'attachment',
        entityId: attachmentId,
        payload: { cardId: ref.cardId, fileName: ready.fileName },
      });
      return { attachment: toAttachment(ready), eventId };
    });

    if (!outcome) {
      const [current] = await this.database.db
        .select()
        .from(attachments)
        .where(eq(attachments.id, attachmentId));
      if (!current) throw new AppError('not_found', 'Not found');
      return toAttachment(current);
    }
    this.events.emit('attachment.ready', {
      eventId: outcome.eventId,
      boardId: ref.boardId,
      actorId: user.id,
      clientMutationId: null,
      attachment: outcome.attachment,
    });
    return outcome.attachment;
  }

  async list(userId: string, cardId: string): Promise<Attachment[]> {
    await this.access.requireForCard(userId, cardId, 'viewer');
    const rows = await this.database.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.cardId, cardId), eq(attachments.status, 'ready')))
      .orderBy(asc(attachments.createdAt), asc(attachments.id));
    return rows.map(toAttachment);
  }

  /** A link that works for `downloadLinkTtlSeconds` (five minutes by default), then stops. */
  async downloadLink(userId: string, attachmentId: string): Promise<DownloadLink> {
    await this.access.requireForAttachment(userId, attachmentId, 'viewer');
    const [row] = await this.database.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, attachmentId));
    if (!row || row.status !== 'ready') throw new AppError('not_found', 'Not found');

    const ttl = this.config.downloadLinkTtlSeconds;
    const url = await getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.config.s3.bucket,
        Key: row.objectKey,
        // What the browser is told about the file is what we verified, not what the client claimed.
        ResponseContentType: row.detectedType ?? 'application/octet-stream',
        ResponseContentDisposition: `attachment; filename="${asciiFallback(row.fileName)}"; filename*=UTF-8''${encodeFilenameStar(row.fileName)}`,
      }),
      { expiresIn: ttl },
    );
    return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  /** Removes a rejected upload completely: the object and the row. */
  private async discard(row: typeof attachments.$inferSelect): Promise<void> {
    try {
      await this.s3.send(
        new DeleteObjectCommand({ Bucket: this.config.s3.bucket, Key: row.objectKey }),
      );
    } catch (error) {
      // The worker's cleanup removes leftovers, so a failure here is not fatal.
      this.logger.warn(
        `could not delete rejected upload ${row.objectKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await this.database.db.delete(attachments).where(eq(attachments.id, row.id));
  }
}
