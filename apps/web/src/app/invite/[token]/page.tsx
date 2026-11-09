import type { InvitePreview, Me } from '@kanban/shared';
import Link from 'next/link';

import { InviteAccept } from '@/features/workspaces';
import { apiFetch, loadPublic } from '@/shared/lib/server-api';

export const metadata = { title: 'Invitation' };

// Rendered per request: it depends on who is asking.
export const dynamic = 'force-dynamic';

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await loadPublic<InvitePreview>(`/invites/${encodeURIComponent(token)}`);
  const me = await apiFetch('/me');
  const user = me.status === 200 ? (me.body as Me) : null;
  const next = encodeURIComponent(`/invite/${token}`);

  if (!invite) {
    return (
      <main id="main" className="mx-auto grid max-w-md gap-4 p-8">
        <h1 className="text-2xl font-semibold">This invitation is not valid</h1>
        <p className="text-muted-foreground">
          It may have expired, been replaced by a newer one, or already been used.
        </p>
        <Link href="/" className="underline">
          Go to your boards
        </Link>
      </main>
    );
  }
  return (
    <main id="main" className="mx-auto grid max-w-md gap-4 p-8">
      <h1 className="text-2xl font-semibold">Join {invite.workspaceName}</h1>
      <p className="text-muted-foreground">
        You were invited as <strong>{invite.role}</strong> with the address{' '}
        <strong>{invite.email}</strong>.
      </p>
      {!user ? (
        <div className="grid gap-2">
          <p>Sign in or create an account with that address to accept.</p>
          <div className="flex gap-4">
            <Link className="underline" href={`/login?next=${next}`}>
              Sign in
            </Link>
            <Link className="underline" href={`/register?next=${next}`}>
              Create account
            </Link>
          </div>
        </div>
      ) : user.email !== invite.email ? (
        <p role="alert" className="text-danger">
          You are signed in as {user.email}. This invitation is for {invite.email}; sign in with
          that account to accept it.
        </p>
      ) : (
        <InviteAccept token={token} />
      )}
    </main>
  );
}
