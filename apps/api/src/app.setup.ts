import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';

import { originGuard } from './common/origin-guard';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { requestContext } from './common/request-context';
import type { AppConfig } from './config';
import { rateLimitMiddleware } from './rate-limit/rate-limit.middleware';
import { RateLimiter } from './rate-limit/rate-limiter';
import { RealtimeService } from './realtime/realtime.service';

/** Everything that turns a bare Nest application into the real API. Shared by main.ts and tests. */
export const configureApp = (app: NestExpressApplication, config: AppConfig): void => {
  app.disable('x-powered-by');

  const requestLogger = new Logger('Http');
  app.use(requestContext((entry) => requestLogger.log(JSON.stringify(entry))));
  app.use(originGuard(config.appOrigin));
  app.use(rateLimitMiddleware(app.get(RateLimiter), config));
  app.useBodyParser('json', { limit: '1mb' });
  app.useGlobalFilters(new AllExceptionsFilter());

  app.get(RealtimeService).attach(app.getHttpServer());

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Kanban API')
      .setDescription('Workspaces, boards, cards, comments, attachments and search.')
      .setVersion('1.0')
      .addCookieAuth('sid')
      .build(),
  );
  SwaggerModule.setup('docs', app, document);
};
