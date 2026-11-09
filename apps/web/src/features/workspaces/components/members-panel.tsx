'use client';

import { WORKSPACE_ROLES, type Member, type WorkspaceRole } from '@kanban/shared';
import { useActionState } from 'react';

import { Button } from '@/shared/ui/button';
import { Field } from '@/shared/ui/field';
import {
  changeRoleAction,
  inviteMemberAction,
  removeMemberAction,
  type ActionState,
} from '../actions';

const Message = ({ state }: { state: ActionState }) =>
  state ? (
    <p
      role={state.ok ? 'status' : 'alert'}
      className={`text-sm ${state.ok ? 'text-muted-foreground' : 'text-danger'}`}
    >
      {state.message}
    </p>
  ) : null;

const MemberRow = ({
  member,
  workspaceId,
  isOwner,
  isSelf,
}: {
  member: Member;
  workspaceId: string;
  isOwner: boolean;
  isSelf: boolean;
}) => {
  const [roleState, roleAction, rolePending] = useActionState(changeRoleAction, null);
  const [removeState, removeAction, removePending] = useActionState(removeMemberAction, null);
  return (
    <li className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[1fr_auto] sm:items-center">
      <div>
        <p className="font-medium">
          {member.user.name} {isSelf ? <span className="text-muted-foreground">(you)</span> : null}
        </p>
        <p className="text-sm text-muted-foreground">
          @{member.user.handle} · {member.user.email}
        </p>
        <Message state={roleState} />
        <Message state={removeState} />
      </div>
      {isOwner ? (
        <div className="flex flex-wrap items-center gap-2">
          <form action={roleAction} className="flex items-center gap-2">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="userId" value={member.user.id} />
            <label className="sr-only" htmlFor={`role-${member.user.id}`}>
              Role of {member.user.name}
            </label>
            <select
              id={`role-${member.user.id}`}
              name="role"
              defaultValue={member.role}
              className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            >
              {WORKSPACE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
            <Button type="submit" size="sm" variant="outline" disabled={rolePending}>
              Save
            </Button>
          </form>
          <form action={removeAction}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="userId" value={member.user.id} />
            <Button
              type="submit"
              size="sm"
              variant="danger"
              disabled={removePending}
              aria-label={`Remove ${member.user.name}`}
            >
              Remove
            </Button>
          </form>
        </div>
      ) : (
        <span className="rounded bg-muted px-2 py-1 text-sm">{member.role}</span>
      )}
    </li>
  );
};

export const MembersPanel = ({
  members,
  workspaceId,
  role,
  currentUserId,
}: {
  members: Member[];
  workspaceId: string;
  role: WorkspaceRole;
  currentUserId: string;
}) => {
  const [inviteState, inviteAction, invitePending] = useActionState(inviteMemberAction, null);
  const isOwner = role === 'owner';
  return (
    <div className="grid gap-8">
      <section aria-labelledby="members-heading" className="grid gap-3">
        <h2 id="members-heading" className="text-lg font-semibold">
          Members
        </h2>
        <ul className="grid gap-2">
          {members.map((member) => (
            <MemberRow
              key={member.user.id}
              member={member}
              workspaceId={workspaceId}
              isOwner={isOwner}
              isSelf={member.user.id === currentUserId}
            />
          ))}
        </ul>
      </section>
      {isOwner ? (
        <section aria-labelledby="invite-heading" className="grid max-w-md gap-3">
          <h2 id="invite-heading" className="text-lg font-semibold">
            Invite someone
          </h2>
          <form action={inviteAction} className="grid gap-3">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <Field label="Email address">
              {(control) => (
                <input {...control} name="email" type="email" required autoComplete="off" />
              )}
            </Field>
            <Field label="Role">
              {(control) => (
                <select {...control} name="role" defaultValue="editor">
                  <option value="editor">editor</option>
                  <option value="viewer">viewer</option>
                </select>
              )}
            </Field>
            <Message state={inviteState} />
            <Button type="submit" disabled={invitePending}>
              {invitePending ? 'Sending…' : 'Send invitation'}
            </Button>
          </form>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only owners can change roles or invite people.
        </p>
      )}
    </div>
  );
};
