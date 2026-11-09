import { idSchema, workspaceRoleSchema } from '@kanban/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { z } from 'zod';

import { REDIS } from '../infra/tokens';

/** Redis channel on which every API instance announces membership changes. */
export const MEMBERSHIP_CHANNEL = 'kanban:membership';

export const membershipEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('removed'), workspaceId: idSchema, userId: idSchema }),
  z.object({
    type: z.literal('role_changed'),
    workspaceId: idSchema,
    userId: idSchema,
    role: workspaceRoleSchema,
  }),
]);
export type MembershipEvent = z.infer<typeof membershipEventSchema>;

/**
 * Tells the realtime layer (on every instance) that someone lost access or changed role, so
 * open Socket.IO connections can be closed at once. Delivery is best-effort; the realtime layer
 * also re-checks membership on every message, so a lost notification cannot keep access alive.
 */
@Injectable()
export class MembershipEvents {
  private readonly logger = new Logger(MembershipEvents.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async publish(event: MembershipEvent): Promise<void> {
    try {
      await this.redis.publish(MEMBERSHIP_CHANNEL, JSON.stringify(event));
    } catch (error) {
      this.logger.warn(
        `could not publish ${event.type}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
