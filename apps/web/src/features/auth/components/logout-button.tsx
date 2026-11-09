'use client';

import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';

import { api } from '@/shared/lib/client-api';
import { Button } from '@/shared/ui/button';

export const LogoutButton = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
        queryClient.clear(); // nothing of the previous user may stay in the cache
        router.replace('/login');
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
};
