import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

export type RequestWithId = Request & { id: string };

const ACCEPTED_ID = /^[\w.-]{8,64}$/;

/**
 * Gives every request an id (taken from a well-formed `X-Request-Id`, else generated), echoes
 * it in the response and logs one line per finished request. Query strings, headers, cookies
 * and bodies are never logged.
 */
export const requestContext =
  (log: (entry: Record<string, unknown>) => void) =>
  (request: Request, response: Response, next: NextFunction): void => {
    const incoming = request.header('x-request-id');
    const id = incoming && ACCEPTED_ID.test(incoming) ? incoming : randomUUID();
    (request as RequestWithId).id = id;
    response.setHeader('X-Request-Id', id);

    const started = process.hrtime.bigint();
    response.on('finish', () => {
      if (request.path === '/health') return;
      log({
        msg: 'request',
        method: request.method,
        path: request.path,
        status: response.statusCode,
        ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
        requestId: id,
      });
    });
    next();
  };
