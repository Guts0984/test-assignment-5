import 'server-only';

import { errorBodySchema, looksLikeIp, signClientIp, type ErrorBody } from '@kanban/shared';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import { serverEnv } from './env.server';

/**
 * THE ONLY way server code (server components, server actions, route handlers) talks to the API.
 *
 * It always attaches the visitor's address, signed with the secret shared with the API. Without
 * it the API would see only this server's address and count every visitor in ONE rate-limit
 * bucket: one spammer would lock out everybody. The address comes from the `X-Real-IP` header
 * that nginx sets from the visitor's connection (a browser cannot forge it: nginx overwrites it).
 * ESLint forbids calling `fetch` anywhere else, so this cannot be forgotten.
 */
export type ApiResult = { status: number; body: unknown; headers: Headers };

export const visitorIp = async (): Promise<string | undefined> => {
  const ip = (await headers()).get('x-real-ip')?.trim();
  return ip && looksLikeIp(ip) ? ip : undefined;
};

export const apiFetch = async (
  path: string,
  options: { method?: string; json?: unknown; withSession?: boolean } = {},
): Promise<ApiResult> => {
  // Reading the request (headers, cookies) FIRST tells Next that this render depends on the
  // request, so the page is never pre-rendered at build time, when no .env exists yet.
  const ip = await visitorIp();
  const session = options.withSession === false ? undefined : (await cookies()).get('sid')?.value;
  const env = serverEnv();

  const response = await fetch(`${env.apiUrl}${path}`, {
    method: options.method ?? (options.json === undefined ? 'GET' : 'POST'),
    cache: 'no-store',
    headers: {
      ...(ip ? await signClientIp(env.clientIpSecret, ip) : {}),
      ...(session ? { cookie: `sid=${session}` } : {}),
      ...(options.json === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, body, headers: response.headers };
};

export const errorOf = (result: ApiResult): ErrorBody['error'] | undefined => {
  const parsed = errorBodySchema.safeParse(result.body);
  return parsed.success ? parsed.data.error : undefined;
};

/** Loads data that needs a signed-in user: no session sends the visitor to the login page. */
export const loadPrivate = async <T>(path: string): Promise<T> => {
  const result = await apiFetch(path);
  if (result.status === 401) redirect('/login');
  if (result.status === 404) notFound();
  if (result.status >= 400) throw new Error(`The API answered ${result.status} for ${path}`);
  return result.body as T;
};

/** Loads data that works without signing in (the invitation page). */
export const loadPublic = async <T>(path: string): Promise<T | null> => {
  const result = await apiFetch(path, { withSession: false });
  if (result.status === 404) return null;
  if (result.status >= 400) throw new Error(`The API answered ${result.status} for ${path}`);
  return result.body as T;
};
