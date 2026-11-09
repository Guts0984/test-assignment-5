import { z } from 'zod';

import { pageSchema, timestampSchema, userRefSchema } from './common';

export const ACTIVITY_TYPES = [
  'card.created',
  'card.updated',
  'card.moved',
  'card.deleted',
  'comment.created',
  'attachment.added',
] as const;
export const activityTypeSchema = z.enum(ACTIVITY_TYPES);
export type ActivityType = z.infer<typeof activityTypeSchema>;

export const activityEntrySchema = z.object({
  /** Monotonic: also the cursor, and the ordering key of realtime events. */
  id: z.number().int(),
  type: activityTypeSchema,
  actor: userRefSchema.nullable(),
  entityType: z.enum(['card', 'comment', 'attachment']),
  entityId: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: timestampSchema,
});
export type ActivityEntry = z.infer<typeof activityEntrySchema>;

export const activityPageSchema = pageSchema(activityEntrySchema);
export type ActivityPage = z.infer<typeof activityPageSchema>;
