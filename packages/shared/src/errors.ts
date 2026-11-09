import { z } from 'zod';

export const ERROR_CODES = [
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'version_conflict',
  'conflict',
  'payload_too_large',
  'unsupported_media_type',
  'rate_limited',
  'service_unavailable',
  'internal_error',
] as const;
export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/**
 * HTTP status for each code. Everything caused by the caller is 4xx; only the last two codes
 * (server fault, dependency down) are 5xx.
 */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  version_conflict: 409,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  service_unavailable: 503,
  internal_error: 500,
};

export const validationIssueSchema = z.object({
  /** Dotted path of the offending field, e.g. `title` or `items.0.id`. Empty for the body itself. */
  path: z.string(),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

/** The single error format of every API response. */
export const errorBodySchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    requestId: z.string().optional(),
    /** Extra data: `{ issues }` for validation errors, `{ current }` for version conflicts. */
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;
