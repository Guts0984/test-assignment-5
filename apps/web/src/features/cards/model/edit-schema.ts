import { LIMITS, rawText, text } from '@kanban/shared';
import { z } from 'zod';

export const editCardSchema = z.object({
  title: text(1, LIMITS.cardTitle),
  description: rawText(0, LIMITS.cardDescription),
});
export type EditCardValues = z.infer<typeof editCardSchema>;
