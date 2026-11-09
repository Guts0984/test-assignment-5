import { z } from 'zod';

import {
  emailSchema,
  idSchema,
  LIMITS,
  text,
  timestampSchema,
  userRefSchema,
  workspaceRoleSchema,
} from './common';

export const workspaceSummarySchema = z.object({
  id: idSchema,
  name: z.string(),
  /** The caller's role in this workspace. */
  role: workspaceRoleSchema,
  boards: z.array(z.object({ id: idSchema, name: z.string() })),
});
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const createWorkspaceBodySchema = z.object({ name: text(1, LIMITS.name) });
export type CreateWorkspaceBody = z.infer<typeof createWorkspaceBodySchema>;

export const memberSchema = z.object({
  user: userRefSchema.extend({ email: z.string() }),
  role: workspaceRoleSchema,
  joinedAt: timestampSchema,
});
export type Member = z.infer<typeof memberSchema>;

/** An invite can grant editor or viewer; owners are made by promoting an existing member. */
export const inviteRoleSchema = z.enum(['editor', 'viewer']);

export const createInviteBodySchema = z.object({
  email: emailSchema,
  role: inviteRoleSchema,
});
export type CreateInviteBody = z.infer<typeof createInviteBodySchema>;

export const inviteSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  email: z.string(),
  role: inviteRoleSchema,
  expiresAt: timestampSchema,
});
export type Invite = z.infer<typeof inviteSchema>;

/** What the invite page shows before the user accepts. */
export const invitePreviewSchema = z.object({
  workspaceName: z.string(),
  email: z.string(),
  role: inviteRoleSchema,
  expiresAt: timestampSchema,
});
export type InvitePreview = z.infer<typeof invitePreviewSchema>;

export const updateMemberBodySchema = z.object({ role: workspaceRoleSchema });
export type UpdateMemberBody = z.infer<typeof updateMemberBodySchema>;

/** An invitation addressed to the signed-in user's own email, shown in the app so it can be accepted without the email. */
export const myInviteSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  workspaceName: z.string(),
  role: inviteRoleSchema,
  invitedBy: z.string(),
  expiresAt: timestampSchema,
});
export type MyInvite = z.infer<typeof myInviteSchema>;
