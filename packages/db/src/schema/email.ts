import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { createdAt, primaryId } from './columns';
import { users } from './users';

export const emailKinds = ['invite', 'mention_digest'] as const;
export type EmailKind = (typeof emailKinds)[number];
export const emailKindEnum = pgEnum('email_kind', emailKinds);

export const emailStatuses = ['pending', 'sent', 'failed'] as const;
export type EmailStatus = (typeof emailStatuses)[number];
export const emailStatusEnum = pgEnum('email_status', emailStatuses);

/**
 * Outbox for every email. Rows are created in the same transaction as the domain change
 * (invite created, mentions claimed), so a worker restart never loses or duplicates a mail:
 * `dedupeKey` (e.g. `invite:<id>`, `digest:<userId>:<firstMentionId>`) is unique, and the
 * worker only sends rows still `pending`.
 *
 * The 15-minute digest limit is evaluated from `createdAt` of the user's previous
 * `mention_digest` rows (see the index below).
 */
export const emailDeliveries = pgTable(
  'email_deliveries',
  {
    id: primaryId(),
    kind: emailKindEnum('kind').notNull(),
    /** Null for invites sent to an address that has no account yet. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    toEmail: text('to_email').notNull(),
    dedupeKey: text('dedupe_key').notNull().unique(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: emailStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('email_deliveries_user_kind_idx').on(t.userId, t.kind, t.createdAt),
    index('email_deliveries_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);
