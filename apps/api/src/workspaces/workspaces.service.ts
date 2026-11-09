import { boards, users, workspaceMembers, workspaces, type DatabaseHandle } from '@kanban/db';
import type { Member, WorkspaceSummary } from '@kanban/shared';
import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';

import { DATABASE } from '../infra/tokens';
import { WorkspaceAccessService } from './workspace-access.service';

@Injectable()
export class WorkspacesService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(WorkspaceAccessService) private readonly access: WorkspaceAccessService,
  ) {}

  /** The caller's workspaces with their role in each and the boards inside. */
  async listFor(userId: string): Promise<WorkspaceSummary[]> {
    const { db } = this.database;
    const memberships = await db
      .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, userId))
      .orderBy(asc(workspaces.name), asc(workspaces.id));
    if (memberships.length === 0) return [];

    const boardRows = await db
      .select({ id: boards.id, workspaceId: boards.workspaceId, name: boards.name })
      .from(boards)
      .where(
        inArray(
          boards.workspaceId,
          memberships.map((workspace) => workspace.id),
        ),
      )
      .orderBy(asc(boards.name), asc(boards.id));

    return memberships.map((workspace) => ({
      ...workspace,
      boards: boardRows
        .filter((board) => board.workspaceId === workspace.id)
        .map(({ id, name }) => ({ id, name })),
    }));
  }

  /** Any member may see who else is in the workspace. */
  async members(userId: string, workspaceId: string): Promise<Member[]> {
    await this.access.require(userId, workspaceId, 'viewer');
    const rows = await this.database.db
      .select({
        id: users.id,
        handle: users.handle,
        name: users.name,
        email: users.email,
        role: workspaceMembers.role,
        joinedAt: workspaceMembers.createdAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .orderBy(asc(workspaceMembers.createdAt), asc(users.id));

    return rows.map((row) => ({
      user: { id: row.id, handle: row.handle, name: row.name, email: row.email },
      role: row.role,
      joinedAt: row.joinedAt.toISOString(),
    }));
  }
}
