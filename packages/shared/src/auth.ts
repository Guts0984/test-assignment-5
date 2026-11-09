import { z } from 'zod';

import { emailSchema, handleSchema, idSchema, LIMITS, rawText, text } from './common';

const passwordSchema = rawText(LIMITS.password.min, LIMITS.password.max);

export const registerBodySchema = z.object({
  email: emailSchema,
  handle: handleSchema,
  name: text(1, LIMITS.name),
  password: passwordSchema,
});
export type RegisterBody = z.infer<typeof registerBodySchema>;

export const loginBodySchema = z.object({
  email: emailSchema,
  // Not length-checked beyond the cap: a wrong password is a 401, not a validation error.
  password: rawText(1, LIMITS.password.max),
});
export type LoginBody = z.infer<typeof loginBodySchema>;

export const meSchema = z.object({
  id: idSchema,
  email: z.string(),
  handle: z.string(),
  name: z.string(),
});
export type Me = z.infer<typeof meSchema>;
