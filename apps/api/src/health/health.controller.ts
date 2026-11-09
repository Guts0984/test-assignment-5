import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/public.decorator';
import { AppError } from '../common/app-error';
import { ReadinessService } from './readiness.service';

@Public()
@ApiTags('health')
@Controller()
export class HealthController {
  constructor(@Inject(ReadinessService) private readonly readiness: ReadinessService) {}

  @Get('health')
  @ApiOperation({ summary: 'Liveness: the process is running (checks no dependency)' })
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness: PostgreSQL, Redis and object storage are reachable' })
  async ready(): Promise<{ status: 'ok'; checks: Record<string, string> }> {
    const { ready, checks } = await this.readiness.check();
    if (!ready) throw new AppError('service_unavailable', 'Not ready', { checks });
    return { status: 'ok', checks };
  }
}
