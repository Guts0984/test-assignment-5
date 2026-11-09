import { ERROR_STATUS, type ErrorCode } from '@kanban/shared';
import { HttpException } from '@nestjs/common';

/** The error to throw from application code: carries a stable code and extra details. */
export class AppError extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message, ERROR_STATUS[code]);
  }
}
