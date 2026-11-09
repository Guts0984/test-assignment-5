import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { JsonLogger } from './common/json-logger';
import { env } from './env';
import { createShutdown } from './shutdown';

const logger = new JsonLogger();

// A dropped promise (for example from a client reconnecting after PostgreSQL or Redis
// restarted) must not take the server down; it is logged instead.
process.on('unhandledRejection', (reason) => {
  logger.error(
    `unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
    undefined,
    'Process',
  );
});
process.on('uncaughtException', (error) => {
  logger.error(`uncaught exception: ${error.message}`, error.stack, 'Process');
  process.exit(1);
});

const app = await NestFactory.create<NestExpressApplication>(AppModule.register(env), {
  bodyParser: false,
  logger,
});
configureApp(app, env);

const shutdown = createShutdown(app, {
  timeoutMs: 25_000,
  exit: (code) => process.exit(code),
  log: (message) => logger.log(message, 'Shutdown'),
});
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen(env.port, '0.0.0.0');
logger.log(`listening on port ${env.port}`, 'Bootstrap');
