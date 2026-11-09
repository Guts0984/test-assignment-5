import { errorBodySchema, type ErrorCode } from '@kanban/shared';

/**
 * Browser-side API access. Calls go to the same origin under /api, where nginx forwards them (and
 * sets the visitor's address itself). ESLint forbids using `fetch` anywhere else.
 */
export type ApiError = Error & {
  status: number;
  code: ErrorCode | 'network';
  details?: Record<string, unknown>;
};

export const isApiError = (value: unknown): value is ApiError =>
  value instanceof Error && typeof (value as Partial<ApiError>).status === 'number';

const apiError = (
  status: number,
  code: ApiError['code'],
  message: string,
  details?: Record<string, unknown>,
): ApiError => Object.assign(new Error(message), { status, code, details });

export const api = async <T = unknown>(
  path: string,
  options: { method?: string; json?: unknown; signal?: AbortSignal } = {},
): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: options.method ?? (options.json === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin',
      signal: options.signal,
      headers: options.json === undefined ? undefined : { 'content-type': 'application/json' },
      body: options.json === undefined ? undefined : JSON.stringify(options.json),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw apiError(0, 'network', 'The server could not be reached. Check your connection.');
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  if (!response.ok) {
    const parsed = errorBodySchema.safeParse(body);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      throw apiError(response.status, code, message, details);
    }
    throw apiError(
      response.status,
      response.status >= 500 ? 'internal_error' : 'validation_failed',
      `Request failed (${response.status})`,
    );
  }
  return body as T;
};

/** A readable sentence for any failure, for toasts and form errors. */
export const describeError = (error: unknown): string => {
  if (!isApiError(error)) return 'Something went wrong. Please try again.';
  switch (error.code) {
    case 'network':
      return error.message;
    case 'unauthorized':
      return 'Your session has ended. Please sign in again.';
    case 'forbidden':
      return 'You do not have permission to do this.';
    case 'not_found':
      return 'This no longer exists, or you no longer have access to it.';
    case 'rate_limited':
      return 'Too many requests. Please wait a moment and try again.';
    case 'version_conflict':
      return 'Someone else changed this at the same time.';
    default:
      return error.status >= 500 ? 'The server had a problem. Please try again.' : error.message;
  }
};
