import 'server-only';

import { describeEnvProblems, readDotEnv } from '@kanban/env';
import { z } from 'zod';

/**
 * Server-only configuration, read from the `.env` file (never from process.env) and validated.
 * `server-only` makes the build fail if a client component ever imports this module, so none of
 * these values can end up in a browser bundle. Evaluated lazily, at the first request: the image
 * is built without a `.env`, which is only mounted when the container runs.
 */
const schema = z.object({
  // Where the API is reachable from the web server (inside the Docker network).
  API_INTERNAL_URL: z.url().default('http://api:3001'),
  // Shared with the API: lets this server vouch for the visitor's address (rate limits).
  CLIENT_IP_SECRET: z.string().min(16),
});

export type ServerEnv = { apiUrl: string; clientIpSecret: string };

let cached: ServerEnv | undefined;

export const serverEnv = (): ServerEnv => {
  if (cached) return cached;
  const result = schema.safeParse(readDotEnv());
  if (!result.success) throw new Error(`Invalid .env: ${describeEnvProblems(result.error.issues)}`);
  cached = {
    apiUrl: result.data.API_INTERNAL_URL.replace(/\/$/, ''),
    clientIpSecret: result.data.CLIENT_IP_SECRET,
  };
  return cached;
};
