import { isIP } from 'node:net';

import type { Request } from 'express';

/**
 * The address of the real client. nginx overwrites `X-Real-IP` with the peer address of the
 * connection it accepted, so that header cannot be forged by a browser. `X-Forwarded-For` is
 * deliberately never read: clients can put anything in it. Without the header (direct access,
 * tests) the socket address is used.
 */
export const clientIp = (request: Request): string => {
  const header = request.header('x-real-ip')?.trim();
  if (header && isIP(header) !== 0) return header;
  return request.socket.remoteAddress ?? 'unknown';
};
