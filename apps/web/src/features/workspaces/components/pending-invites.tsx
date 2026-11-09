'use client';

import type { MyInvite } from '@kanban/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { api, describeError } from '@/shared/lib/client-api';
import { Button } from '@/shared/ui/button';

/** Invitations sent to me, to accept right here: the emailed link is not the only way in. */
export const PendingInvites = ({ invites }: { invites: MyInvite[] }) => {
  const router = useRouter();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  if (invites.length === 0) return null;

  const accept = async (id: string) => {
    setBusy(id);
    setError(undefined);
    try {
      await api(`/me/invites/${id}/accept`, { method: 'POST' });
      router.refresh();
    } catch (caught) {
      setError(describeError(caught));
      setBusy(undefined);
    }
  };

  return (
    <section
      aria-labelledby="pending-invites"
      className="grid gap-3 rounded-lg border border-primary p-4"
    >
      <h2 id="pending-invites" className="text-lg font-semibold">
        Invitations for you
      </h2>
      <ul className="grid gap-2">
        {invites.map((invite) => (
          <li key={invite.id} className="flex flex-wrap items-center justify-between gap-3">
            <span>
              <strong>{invite.workspaceName}</strong> as {invite.role}, invited by{' '}
              {invite.invitedBy}
            </span>
            <Button
              size="sm"
              disabled={busy === invite.id}
              onClick={() => void accept(invite.id)}
              aria-label={`Accept the invitation to ${invite.workspaceName}`}
            >
              {busy === invite.id ? 'Joining…' : 'Accept'}
            </Button>
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
};
