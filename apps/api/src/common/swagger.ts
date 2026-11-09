import { applyDecorators } from '@nestjs/common';
import { ApiBody, type ApiBodyOptions } from '@nestjs/swagger';
import { z } from 'zod';

/**
 * Documents a request body with the very Zod schema that validates it, so the OpenAPI document
 * can never disagree with what the API accepts.
 */
export const ZodBody = (schema: z.ZodType) =>
  applyDecorators(
    ApiBody({
      schema: z.toJSONSchema(schema, {
        target: 'openapi-3.0',
        io: 'input',
        unrepresentable: 'any',
      }),
    } as ApiBodyOptions),
  );
