'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { api, describeError } from '@/shared/lib/client-api';
import { Button } from '@/shared/ui/button';

export const InviteAccept = ({ token }: { token: string }) => {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  return (
    <div className="grid gap-3">
      <Button
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(undefined);
          try {
            await api(`/invites/${encodeURIComponent(token)}/accept`, { method: 'POST' });
            router.replace('/');
            router.refresh();
          } catch (caught) {
            setError(describeError(caught));
            setPending(false);
          }
        }}
      >
        {pending ? 'Joining…' : 'Accept invitation'}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
};
