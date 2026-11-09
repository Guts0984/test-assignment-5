import { createHash, randomBytes } from 'node:crypto';

import {
  emailDeliveries,
  users,
  workspaceInvites,
  workspaceMembers,
  workspaces,
  type DatabaseHandle,
} from '@kanban/db';
import type { CreateInviteBody, Invite, InvitePreview, WorkspaceRole } from '@kanban/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';

import { AppError } from '../common/app-error';
import type { AuthUser } from '../auth/auth-user';
import type { AppConfig } from '../config';
import { APP_CONFIG, DATABASE } from '../infra/tokens';
import { WorkspaceAccessService } from './workspace-access.service';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

@Injectable()
export class InvitesService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(WorkspaceAccessService) private readonly access: WorkspaceAccessService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Only owners invite. The invite and its email are written in ONE transaction: the email
   * goes to the outbox table, which the worker drains, so a crash can neither lose the mail nor
   * send it twice. Inviting the same address again replaces the open invite (new link, old
   * link stops working) and queues a new mail.
   */
  async create(actor: AuthUser, workspaceId: string, body: CreateInviteBody): Promise<Invite> {
    await this.access.require(actor.id, workspaceId, 'owner');
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + this.config.inviteTtlSeconds * 1000);

    return this.database.db.transaction(async (tx) => {
      const [workspace] = await tx
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      if (!workspace) throw new AppError('not_found', 'Not found');

      const [existing] = await tx
        .select({ id: users.id })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(users.email, body.email)))
        .limit(1);
      if (existing) throw new AppError('conflict', 'This person is already a member');

      const [invite] = await tx
        .insert(workspaceInvites)
        .values({
          workspaceId,
          email: body.email,
          role: body.role,
          tokenHash,
          invitedBy: actor.id,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: [workspaceInvites.workspaceId, workspaceInvites.email],
          targetWhere: isNull(workspaceInvites.acceptedAt),
          set: {
            role: body.role,
            tokenHash,
            invitedBy: actor.id,
            expiresAt,
            createdAt: new Date(),
          },
        })
        .returning();
      if (!invite) throw new Error('invite upsert returned nothing');

      // The payload holds the link until the worker has sent the mail, then the worker clears it.
      await tx.insert(emailDeliveries).values({
        kind: 'invite',
        toEmail: body.email,
        dedupeKey: `invite:${invite.id}:${tokenHash.slice(0, 16)}`,
        payload: {
          workspaceName: workspace.name,
          role: body.role,
          invitedBy: actor.name,
          link: `${this.config.appOrigin}/invite/${token}`,
        },
      });

      return {
        id: invite.id,
        workspaceId,
        email: invite.email,
        role: body.role,
        expiresAt: invite.expiresAt.toISOString(),
      };
    });
  }

  /** What the invite page shows. Public: the secret token is the credential. */
  async preview(token: string): Promise<InvitePreview> {
    if (!TOKEN.test(token)) throw new AppError('not_found', 'Not found');
    const [row] = await this.database.db
      .select({
        workspaceName: workspaces.name,
        email: workspaceInvites.email,
        role: workspaceInvites.role,
        expiresAt: workspaceInvites.expiresAt,
      })
      .from(workspaceInvites)
      .innerJoin(workspaces, eq(workspaces.id, workspaceInvites.workspaceId))
      .where(
        and(
          eq(workspaceInvites.tokenHash, hashToken(token)),
          isNull(workspaceInvites.acceptedAt),
          gt(workspaceInvites.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!row || row.role === 'owner') throw new AppError('not_found', 'Not found');
    return {
      workspaceName: row.workspaceName,
      email: row.email,
      role: row.role,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  /** The signed-in user must own the invited address. Accepting is atomic: one winner. */
  async accept(
    user: AuthUser,
    token: string,
  ): Promise<{ workspaceId: string; role: WorkspaceRole }> {
    if (!TOKEN.test(token)) throw new AppError('not_found', 'Not found');
    return this.database.db.transaction(async (tx) => {
      const [invite] = await tx
        .select()
        .from(workspaceInvites)
        .where(
          and(
            eq(workspaceInvites.tokenHash, hashToken(token)),
            isNull(workspaceInvites.acceptedAt),
            gt(workspaceInvites.expiresAt, new Date()),
          ),
        )
        .for('update')
        .limit(1);
      if (!invite) throw new AppError('not_found', 'Not found');
      if (invite.email !== user.email) {
        throw new AppError('forbidden', 'This invitation was sent to a different email address');
      }

      await tx
        .update(workspaceInvites)
        .set({ acceptedAt: new Date() })
        .where(eq(workspaceInvites.id, invite.id));
      await tx
        .insert(workspaceMembers)
        .values({ workspaceId: invite.workspaceId, userId: user.id, role: invite.role })
        .onConflictDoNothing();
      const [member] = await tx
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, invite.workspaceId),
            eq(workspaceMembers.userId, user.id),
          ),
        );
      return { workspaceId: invite.workspaceId, role: member?.role ?? invite.role };
    });
  }
}
