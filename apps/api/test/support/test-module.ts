import { text } from '@kanban/shared';
import { Body, Controller, Get, Inject, Module, Param, Post, Query } from '@nestjs/common';
import type { DatabaseHandle } from '@kanban/db';
import { Redis } from 'ioredis';
import { z } from 'zod';

import { Public } from '../../src/auth/public.decorator';
import { AppError } from '../../src/common/app-error';
import { ZodValidationPipe } from '../../src/common/zod-validation.pipe';
import { DATABASE, REDIS } from '../../src/infra/tokens';

const echoSchema = z.object({ title: text(1, 10), n: z.number().int() });

/** Routes that exist only in tests, to provoke every kind of failure on purpose. */
@Public()
@Controller('t')
class TestController {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Post('echo')
  echo(@Body(new ZodValidationPipe(echoSchema)) body: z.infer<typeof echoSchema>) {
    return body;
  }

  @Get('param/:id')
  param(@Param('id') id: string) {
    return { id };
  }

  @Get('boom')
  boom(): never {
    throw new Error('secret internal detail: /etc/passwd password=hunter2');
  }

  @Get('app-error')
  appError(): never {
    throw new AppError('forbidden', 'Viewers cannot do this', { why: 'role' });
  }

  @Get('pg-nul')
  async pgNul() {
    await this.database.pool.query('select $1::text', ['a\u0000b']);
  }

  @Get('pg-check')
  async pgCheck() {
    await this.database.pool.query(`insert into workspaces (name) values ('')`);
  }

  @Get('db')
  async db() {
    await this.database.pool.query('select 1');
    return { ok: true };
  }

  @Get('redis')
  async redisPing() {
    return { pong: await this.redis.ping() };
  }

  @Get('slow')
  async slow(@Query('ms') ms: string) {
    await new Promise((resolve) => setTimeout(resolve, Number(ms)));
    return { done: true };
  }
}

@Module({ controllers: [TestController] })
export class TestModule {}
