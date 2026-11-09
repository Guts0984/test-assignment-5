import { z } from 'zod';

import { idSchema, LIMITS, rawText, text, timestampSchema, workspaceRoleSchema } from './common';

export const columnSchema = z.object({
  id: idSchema,
  boardId: idSchema,
  name: z.string(),
  /** Fractional-index key. Clients sort columns and cards by it (byte-wise) and never write it. */
  position: z.string(),
});
export type Column = z.infer<typeof columnSchema>;

export const cardSchema = z.object({
  id: idSchema,
  boardId: idSchema,
  columnId: idSchema,
  title: z.string(),
  description: z.string(),
  position: z.string(),
  /** Optimistic-lock counter of the card's content; moving a card does not change it. */
  version: z.number().int().min(1),
  createdBy: idSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Card = z.infer<typeof cardSchema>;

/** Response of `GET /boards/:id`: the whole board in one go. */
export const boardSchema = z.object({
  board: z.object({ id: idSchema, workspaceId: idSchema, name: z.string() }),
  /** The caller's role, so the UI can disable what the server would refuse anyway. */
  role: workspaceRoleSchema,
  columns: z.array(columnSchema),
  cards: z.array(cardSchema),
});
export type BoardSnapshot = z.infer<typeof boardSchema>;

/** Lets a client recognise the echo of its own change coming back over the socket. */
export const clientMutationIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\w-]+$/);

export const createCardBodySchema = z.object({
  columnId: idSchema,
  title: text(1, LIMITS.cardTitle),
  description: rawText(0, LIMITS.cardDescription).default(''),
  /** Insert directly after / before this card; both absent means the end of the column. */
  afterId: idSchema.nullish(),
  beforeId: idSchema.nullish(),
  clientMutationId: clientMutationIdSchema.optional(),
});
export type CreateCardBody = z.infer<typeof createCardBodySchema>;

export const updateCardBodySchema = z
  .object({
    /** The version the editor started from; a mismatch is answered with 409. */
    version: z.number().int().min(1),
    title: text(1, LIMITS.cardTitle).optional(),
    description: rawText(0, LIMITS.cardDescription).optional(),
    clientMutationId: clientMutationIdSchema.optional(),
  })
  .refine((body) => body.title !== undefined || body.description !== undefined, {
    message: 'provide at least one of: title, description',
  });
export type UpdateCardBody = z.infer<typeof updateCardBodySchema>;

/** Body of the 409 answer to a stale `PATCH`: the version that won, so the UI can show it. */
export const versionConflictDetailsSchema = z.object({ current: cardSchema });
export type VersionConflictDetails = z.infer<typeof versionConflictDetailsSchema>;

export const moveCardBodySchema = z.object({
  columnId: idSchema,
  /** Neighbour that should end up directly above the card (null / absent: none). */
  afterId: idSchema.nullish(),
  /** Neighbour that should end up directly below the card (null / absent: none). */
  beforeId: idSchema.nullish(),
  clientMutationId: clientMutationIdSchema.optional(),
});
export type MoveCardBody = z.infer<typeof moveCardBodySchema>;

export const moveCardResponseSchema = z.object({
  card: cardSchema,
  fromColumnId: idSchema,
  /** True if every key of the column was rewritten (announced separately as `column.rebalanced`). */
  rebalanced: z.boolean(),
});
export type MoveCardResponse = z.infer<typeof moveCardResponseSchema>;
