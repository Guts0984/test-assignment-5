import { isIP } from 'node:net';

import { CLIENT_IP_HEADER, CLIENT_IP_SIGNATURE_HEADER, verifyClientIp } from '@kanban/shared';

type Headers = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string | undefined =>
  (Array.isArray(value) ? value[0] : value)?.trim();

/**
 * The address of the real visitor, from the most to the least trustworthy source:
 *
 *  1. a SIGNED address from the Next.js server, which calls the API for the visitor and would
 *     otherwise make everybody look like the web server;
 *  2. `X-Real-IP`, which nginx overwrites with the address it accepted the connection from, so a
 *     browser cannot forge it (this is the path of browser -> nginx -> API);
 *  3. the address of the connection itself (direct access, tests).
 *
 * `X-Forwarded-For` is never read: any client can put anything in it.
 * Used by both the HTTP limiter and the Socket.IO limits, so a visitor has one identity everywhere.
 */
export const clientIpOf = async (
  headers: Headers,
  peerAddress: string | undefined,
  secret: string,
): Promise<string> => {
  const signed = await verifyClientIp(
    secret,
    first(headers[CLIENT_IP_HEADER]),
    first(headers[CLIENT_IP_SIGNATURE_HEADER]),
  );
  if (signed) return signed;

  const real = first(headers['x-real-ip']);
  if (real && isIP(real) !== 0) return real;

  return peerAddress ?? 'unknown';
};
