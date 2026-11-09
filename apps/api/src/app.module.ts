import { Module, type DynamicModule, type ModuleMetadata } from '@nestjs/common';

import type { AppConfig } from './config';
import { HealthController } from './health/health.controller';
import { ReadinessService } from './health/readiness.service';
import { AttachmentsModule } from './attachments/attachments.module';
import { AuthModule } from './auth/auth.module';
import { BoardsModule } from './boards/boards.module';
import { CommentsModule } from './comments/comments.module';
import { InfraModule } from './infra/infra.module';
import { RateLimiter } from './rate-limit/rate-limiter';
import { RealtimeModule } from './realtime/realtime.module';
import { SearchModule } from './search/search.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

@Module({})
export class AppModule {
  /** `extraImports` exists for tests, which add throw-away controllers. */
  static register(config: AppConfig, extraImports: ModuleMetadata['imports'] = []): DynamicModule {
    return {
      module: AppModule,
      imports: [
        InfraModule.register(config),
        AuthModule,
        WorkspacesModule,
        BoardsModule,
        CommentsModule,
        AttachmentsModule,
        SearchModule,
        RealtimeModule,
        ...extraImports,
      ],
      controllers: [HealthController],
      providers: [ReadinessService, RateLimiter],
    };
  }
}
