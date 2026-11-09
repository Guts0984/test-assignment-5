import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';

import { cards } from './cards';
import { createdAt, primaryId, tsvector } from './columns';
import { emailDeliveries } from './email';
import { users } from './users';
import { workspaces } from './workspaces';

export const comments = pgTable(
  'comments',
  {
    id: primaryId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    cardId: uuid('card_id').notNull(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    createdAt: createdAt(),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(body, ''))`,
    ),
  },
  (t) => [
    foreignKey({
      name: 'comments_card_workspace_fk',
      columns: [t.cardId, t.workspaceId],
      foreignColumns: [cards.id, cards.workspaceId],
    }).onDelete('cascade'),
    check('comments_body_length', sql`char_length(${t.body}) between 1 and 5000`),
    index('comments_card_idx').on(t.cardId, t.createdAt, t.id),
    index('comments_search_idx').using('gin', t.searchVector),
  ],
);

/**
 * One row per (comment, mentioned user). `deliveryId` is set when the mention has been
 * claimed by a digest email, which makes digest creation atomic and idempotent: a mention
 * belongs to at most one digest.
 */
export const commentMentions = pgTable(
  'comment_mentions',
  {
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deliveryId: uuid('delivery_id').references(() => emailDeliveries.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.commentId, t.userId] }),
    // Worker: unclaimed mentions of a user.
    index('comment_mentions_unclaimed_idx')
      .on(t.userId, t.createdAt)
      .where(sql`${t.deliveryId} is null`),
  ],
);
