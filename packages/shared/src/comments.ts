import { z } from 'zod';

import { idSchema, LIMITS, rawText, timestampSchema, userRefSchema } from './common';

export const commentSchema = z.object({
  id: idSchema,
  cardId: idSchema,
  author: userRefSchema,
  body: z.string(),
  /** Workspace members referenced as `@handle` in the body (unknown handles are dropped). */
  mentions: z.array(userRefSchema),
  createdAt: timestampSchema,
});
export type Comment = z.infer<typeof commentSchema>;

export const createCommentBodySchema = z.object({
  body: rawText(1, LIMITS.commentBody).refine((body) => body.trim().length > 0, {
    message: 'comment must not be blank',
  }),
});
export type CreateCommentBody = z.infer<typeof createCommentBodySchema>;
