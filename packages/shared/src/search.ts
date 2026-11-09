import { z } from 'zod';

import { cursorSchema, idSchema, LIMITS, pageSchema, text } from './common';

export const searchQuerySchema = z.object({
  q: text(1, LIMITS.searchQuery),
  workspace: idSchema,
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.pageSize.max).default(LIMITS.pageSize.default),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/**
 * Highlighted text as segments, never as HTML: the client renders matches as `<mark>` itself,
 * so user-written content can never inject markup.
 */
export const highlightedTextSchema = z.array(z.object({ text: z.string(), match: z.boolean() }));
export type HighlightedText = z.infer<typeof highlightedTextSchema>;

export const searchResultSchema = z.object({
  kind: z.enum(['card', 'comment']),
  boardId: idSchema,
  cardId: idSchema,
  commentId: idSchema.nullable(),
  cardTitle: highlightedTextSchema,
  /** The matching part of the description or comment. */
  snippet: highlightedTextSchema,
  rank: z.number(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchPageSchema = pageSchema(searchResultSchema);
export type SearchPage = z.infer<typeof searchPageSchema>;
