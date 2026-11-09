import { ERROR_STATUS, type ErrorCode } from '@kanban/shared';
import { HttpException } from '@nestjs/common';

import { AppError } from './app-error';

export type MappedError = {
  status: number;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  /** Log this error with its stack (it is a server fault we did not anticipate). */
  unexpected: boolean;
};

const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: 'validation_failed',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
  503: 'service_unavailable',
};

const GENERIC_MESSAGE: Record<ErrorCode, string> = {
  validation_failed: 'Invalid request',
  unauthorized: 'Authentication required',
  forbidden: 'You do not have permission to do this',
  not_found: 'Not found',
  version_conflict: 'The resource was changed by someone else',
  conflict: 'The request conflicts with the current state',
  payload_too_large: 'Request body is too large',
  unsupported_media_type: 'Unsupported content type',
  rate_limited: 'Too many requests',
  service_unavailable: 'A dependency is temporarily unavailable',
  internal_error: 'Internal server error',
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

/** Finds an error carrying an SQLSTATE, looking through `cause` chains (Drizzle wraps pg errors). */
const findPgCode = (error: unknown): string | undefined => {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    const record = asRecord(current);
    if (typeof record?.code === 'string' && /^[0-9A-Z]{5}$/.test(record.code)) return record.code;
    current = record?.cause;
  }
  return undefined;
};

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

const isDependencyDown = (error: unknown): boolean => {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    const record = asRecord(current);
    if (typeof record?.code === 'string' && NETWORK_CODES.has(record.code)) return true;
    if (record?.name === 'TimeoutError' || record?.name === 'ConnectionTimeoutError') return true;
    const message = typeof record?.message === 'string' ? record.message : '';
    if (
      /Connection terminated|timeout exceeded when trying to connect|Command timed out|Stream isn't writeable|Connection is closed/i.test(
        message,
      )
    )
      return true;
    current = record?.cause;
  }
  return false;
};

const of = (
  code: ErrorCode,
  message?: string,
  details?: Record<string, unknown>,
  unexpected = false,
): MappedError => ({
  status: ERROR_STATUS[code],
  code,
  message: message ?? GENERIC_MESSAGE[code],
  details,
  unexpected,
});

/**
 * Turns anything that can be thrown into the single API error shape. Rules:
 *  - our own and Nest's HTTP errors keep their status;
 *  - errors from the HTTP layer (invalid JSON, body too large, bad URL encoding) are 4xx;
 *  - database errors caused by the data (SQLSTATE class 22, CHECK/UNIQUE/FK violations) are 4xx
 *    as a safety net behind validation; a dependency that is down or too slow is 503;
 *  - everything else is a 500 whose message never reveals internals.
 */
export const mapError = (error: unknown): MappedError => {
  if (error instanceof AppError) return of(error.code, error.message, error.details);

  if (error instanceof HttpException) {
    const status = error.getStatus();
    const code = CODE_BY_STATUS[status] ?? (status < 500 ? 'validation_failed' : 'internal_error');
    return of(code, status < 500 ? error.message : undefined, undefined, status >= 500);
  }

  const record = asRecord(error);
  const httpStatus = record?.status ?? record?.statusCode;
  if (typeof httpStatus === 'number' && httpStatus >= 400 && httpStatus < 500) {
    return of(CODE_BY_STATUS[httpStatus] ?? 'validation_failed');
  }
  if (error instanceof URIError) return of('validation_failed', 'Malformed URL encoding');

  const pgCode = findPgCode(error);
  if (pgCode) {
    if (pgCode.startsWith('22') || pgCode === '23514')
      return of('validation_failed', 'Invalid value');
    if (pgCode === '23505' || pgCode === '23503') return of('conflict');
    if (
      pgCode.startsWith('08') ||
      pgCode.startsWith('57') ||
      pgCode === '40001' ||
      pgCode === '40P01'
    ) {
      return of('service_unavailable');
    }
  }
  if (isDependencyDown(error)) return of('service_unavailable');

  return of('internal_error', undefined, undefined, true);
};
