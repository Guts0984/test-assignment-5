import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

import { AppError } from './app-error';

/** Validates a body, query or param with a Zod schema from @kanban/shared. */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw new AppError('validation_failed', 'Request validation failed', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
}
