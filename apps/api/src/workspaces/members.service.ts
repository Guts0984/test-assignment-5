import { workspaceMembers, type DatabaseHandle, type Transaction } from '@kanban/db';
import type { WorkspaceRole } from '@kanban/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { AppError } from '../common/app-error';
import { DATABASE } from '../infra/tokens';
import { MembershipEvents } from './membership-events';
import { WorkspaceAccessService } from './workspace-access.service';

@Injectable()
export class MembersService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(WorkspaceAccessService) private readonly access: WorkspaceAccessService,
    @Inject(MembershipEvents) private readonly events: MembershipEvents,
  ) {}

  async changeRole(
    actorId: string,
    workspaceId: string,
    targetId: string,
    role: WorkspaceRole,
  ): Promise<void> {
    await this.access.require(actorId, workspaceId, 'owner');
    await this.guardedChange(actorId, workspaceId, targetId, role, async (tx) => {
      await tx
        .update(workspaceMembers)
        .set({ role })
        .where(
          and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetId)),
        );
    });
    await this.events.publish({ type: 'role_changed', workspaceId, userId: targetId, role });
  }

  async remove(actorId: string, workspaceId: string, targetId: string): Promise<void> {
    await this.access.require(actorId, workspaceId, 'owner');
    await this.guardedChange(actorId, workspaceId, targetId, null, async (tx) => {
      await tx
        .delete(workspaceMembers)
        .where(
          and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetId)),
        );
    });
    await this.events.publish({ type: 'removed', workspaceId, userId: targetId });
  }

  /**
   * Runs a change to one member while holding locks on every owner row of the workspace.
   * Two owners changing owners at the same moment therefore run one after the other, and the
   * "a workspace always keeps an owner" rule is checked against the state the other one left.
   * The actor's own ownership is re-checked under the lock, so someone demoted a moment ago
   * cannot still act as an owner.
   */
  private async guardedChange(
    actorId: string,
    workspaceId: string,
    targetId: string,
    /** The role the target ends up with, or null if they are removed. */
    nextRole: WorkspaceRole | null,
    apply: (tx: Transaction) => Promise<void>,
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const owners = await tx
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(
          and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'owner')),
        )
        .for('update');
      if (!owners.some((owner) => owner.userId === actorId)) {
        throw new AppError('forbidden', 'You do not have permission to do this');
      }

      const [target] = await tx
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetId)),
        )
        .for('update')
        .limit(1);
      if (!target) throw new AppError('not_found', 'Not found');

      const losesOwnership = target.role === 'owner' && nextRole !== 'owner';
      if (losesOwnership && owners.length <= 1) {
        throw new AppError('conflict', 'A workspace must keep at least one owner');
      }
      await apply(tx);
    });
  }
}
