import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, primaryId } from './columns';
import { users } from './users';

export const workspaceRoles = ['owner', 'editor', 'viewer'] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];
export const workspaceRoleEnum = pgEnum('workspace_role', workspaceRoles);

export const workspaces = pgTable(
  'workspaces',
  {
    id: primaryId(),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [check('workspaces_name_length', sql`char_length(${t.name}) between 1 and 100`)],
);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: workspaceRoleEnum('role').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    // "my workspaces" lookup
    index('workspace_members_user_idx').on(t.userId),
  ],
);

/**
 * Invitations by email. Only a SHA-256 hash of the token is stored, so a database leak does
 * not expose usable invite links. At most one open (not yet accepted) invite per email per
 * workspace.
 */
export const workspaceInvites = pgTable(
  'workspace_invites',
  {
    id: primaryId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: workspaceRoleEnum('role').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check('workspace_invites_email_lowercase', sql`${t.email} = lower(${t.email})`),
    check('workspace_invites_role_not_owner', sql`${t.role} <> 'owner'`),
    uniqueIndex('workspace_invites_open_unique')
      .on(t.workspaceId, t.email)
      .where(sql`${t.acceptedAt} is null`),
  ],
);
