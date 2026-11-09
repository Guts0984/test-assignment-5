'use server';

import { updateMemberBodySchema, createInviteBodySchema, idSchema } from '@kanban/shared';
import { revalidatePath } from 'next/cache';

import { apiFetch, errorOf } from '@/shared/lib/server-api';

export type ActionState = { ok: boolean; message: string } | null;

const fail = (message: string): ActionState => ({ ok: false, message });

/**
 * Server Actions for the settings page. They run on the web server, so they use the shared
 * server API client, which signs the visitor's address and forwards the session cookie.
 * Permissions are enforced by the API (only owners); the UI merely hides what would be refused.
 */
export const changeRoleAction = async (
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> => {
  const workspaceId = idSchema.safeParse(formData.get('workspaceId'));
  const userId = idSchema.safeParse(formData.get('userId'));
  const body = updateMemberBodySchema.safeParse({ role: formData.get('role') });
  if (!workspaceId.success || !userId.success || !body.success)
    return fail('That change is not valid.');

  const result = await apiFetch(`/workspaces/${workspaceId.data}/members/${userId.data}`, {
    method: 'PATCH',
    json: body.data,
  });
  if (result.status >= 400)
    return fail(errorOf(result)?.message ?? 'The role could not be changed.');
  revalidatePath(`/workspaces/${workspaceId.data}/settings`);
  return { ok: true, message: 'Role updated.' };
};

export const removeMemberAction = async (
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> => {
  const workspaceId = idSchema.safeParse(formData.get('workspaceId'));
  const userId = idSchema.safeParse(formData.get('userId'));
  if (!workspaceId.success || !userId.success) return fail('That change is not valid.');

  const result = await apiFetch(`/workspaces/${workspaceId.data}/members/${userId.data}`, {
    method: 'DELETE',
  });
  if (result.status >= 400)
    return fail(errorOf(result)?.message ?? 'The member could not be removed.');
  revalidatePath(`/workspaces/${workspaceId.data}/settings`);
  return { ok: true, message: 'Member removed.' };
};

export const inviteMemberAction = async (
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> => {
  const workspaceId = idSchema.safeParse(formData.get('workspaceId'));
  const body = createInviteBodySchema.safeParse({
    email: formData.get('email'),
    role: formData.get('role'),
  });
  if (!workspaceId.success) return fail('That change is not valid.');
  if (!body.success) return fail(body.error.issues[0]?.message ?? 'Check the email address.');

  const result = await apiFetch(`/workspaces/${workspaceId.data}/invites`, {
    method: 'POST',
    json: body.data,
  });
  if (result.status >= 400)
    return fail(errorOf(result)?.message ?? 'The invitation could not be sent.');
  return { ok: true, message: `Invitation sent to ${body.data.email}.` };
};
