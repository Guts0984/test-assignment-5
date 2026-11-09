import { z } from 'zod';

export const WORKSPACE_ROLES = ['owner', 'editor', 'viewer'] as const;
export const workspaceRoleSchema = z.enum(WORKSPACE_ROLES);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

/**
 * Size limits shared by every layer. The database CHECK constraints repeat the same numbers;
 * a test in `packages/db` fails if the two ever drift apart.
 */
export const LIMITS = {
  name: 100,
  cardTitle: 200,
  cardDescription: 20_000,
  commentBody: 5_000,
  password: { min: 8, max: 128 },
  searchQuery: 200,
  fileName: 255,
  /** 10 MB. */
  attachmentBytes: 10 * 1024 * 1024,
  pageSize: { default: 50, max: 100 },
  cursor: 512,
} as const;

/** PostgreSQL rejects NUL (U+0000) in text; reject it at the edge so it is a 4xx, never a 5xx. */
const hasNoNul = (value: string): boolean => !value.includes('\u0000');
const NO_NUL = { message: 'must not contain NUL characters' };

/** Trimmed, length-bounded text without NUL bytes. */
export const text = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine(hasNoNul, NO_NUL);

/** Like `text` but keeps surrounding whitespace (comment bodies, descriptions). */
export const rawText = (min: number, max: number) =>
  z.string().min(min).max(max).refine(hasNoNul, NO_NUL);

/**
 * Any 8-4-4-4-12 hex id. Deliberately not RFC-strict: PostgreSQL accepts every such string,
 * so anything else must be rejected here, before it can reach the database.
 */
export const idSchema = z.guid();

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

/** Lowercase, 3-32 characters, starts and ends with a letter or digit. */
export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,30}[a-z0-9]$/;
export const handleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(HANDLE_PATTERN, 'use 3-32 letters, digits, "_", "." or "-"');

export const timestampSchema = z.iso.datetime();

/** Opaque pagination cursor: only the server knows how to read it. */
export const cursorSchema = z.string().min(1).max(LIMITS.cursor).refine(hasNoNul, NO_NUL);

/** Query-string pagination parameters (strings in, validated numbers out). */
export const pageQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.pageSize.max).default(LIMITS.pageSize.default),
});

export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: cursorSchema.nullable() });

/** A person as shown next to comments, mentions and in presence lists. */
export const userRefSchema = z.object({ id: idSchema, handle: z.string(), name: z.string() });
export type UserRef = z.infer<typeof userRefSchema>;
