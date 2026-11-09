import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { cards } from './cards';
import { createdAt, primaryId } from './columns';
import { users } from './users';
import { workspaces } from './workspaces';

export const attachmentStatuses = ['pending', 'ready'] as const;
export type AttachmentStatus = (typeof attachmentStatuses)[number];
export const attachmentStatusEnum = pgEnum('attachment_status', attachmentStatuses);

export const attachments = pgTable(
  'attachments',
  {
    id: primaryId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    cardId: uuid('card_id').notNull(),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id),
    objectKey: text('object_key').notNull().unique(),
    fileName: text('file_name').notNull(),
    /** Type claimed by the client when requesting the upload URL. */
    declaredType: text('declared_type').notNull(),
    /** Type detected from the file content at `complete`; authoritative once set. */
    detectedType: text('detected_type'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    status: attachmentStatusEnum('status').notNull().default('pending'),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'attachments_card_workspace_fk',
      columns: [t.cardId, t.workspaceId],
      foreignColumns: [cards.id, cards.workspaceId],
    }),
    check('attachments_size_limit', sql`${t.sizeBytes} between 1 and 10485760`),
    check('attachments_file_name_length', sql`char_length(${t.fileName}) between 1 and 255`),
    check(
      'attachments_ready_has_type',
      sql`${t.status} <> 'ready' or (${t.detectedType} is not null and ${t.completedAt} is not null)`,
    ),
    index('attachments_card_idx').on(t.cardId),
    // Worker: stale pending uploads.
    index('attachments_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);
