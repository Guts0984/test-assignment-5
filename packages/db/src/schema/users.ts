import { sql } from 'drizzle-orm';
import { check, pgTable, text } from 'drizzle-orm/pg-core';

import { createdAt, primaryId } from './columns';

/**
 * `email` and `handle` are stored already lowercased (enforced by CHECK), so plain UNIQUE
 * constraints are case-insensitive. `handle` is what `@mentions` resolve against.
 */
export const users = pgTable(
  'users',
  {
    id: primaryId(),
    email: text('email').notNull().unique(),
    handle: text('handle').notNull().unique(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('users_email_lowercase', sql`${t.email} = lower(${t.email})`),
    check('users_handle_format', sql`${t.handle} ~ '^[a-z0-9_.-]{3,32}$'`),
    check('users_name_length', sql`char_length(${t.name}) between 1 and 100`),
  ],
);
