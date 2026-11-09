import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

import { mapError } from './error-mapping';

/** Last line of defence: every error, whatever its origin, leaves as the same JSON shape. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: string }>();
    const response = http.getResponse<Response>();
    const mapped = mapError(exception);

    if (mapped.unexpected) {
      this.logger.error(
        `${request.method} ${request.path} -> ${mapped.status}: ${exception instanceof Error ? exception.message : String(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    if (response.headersSent) {
      response.end();
      return;
    }
    response.status(mapped.status).json({
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(request.id ? { requestId: request.id } : {}),
        ...(mapped.details ? { details: mapped.details } : {}),
      },
    });
  }
}
