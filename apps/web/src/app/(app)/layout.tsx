import type { Me } from '@kanban/shared';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { LogoutButton } from '@/features/auth';
import { loadPrivate } from '@/shared/lib/server-api';

// Rendered per request: it depends on who is asking.
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await loadPrivate<Me>('/me');
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2">
        <nav aria-label="Main" className="flex items-center gap-4">
          <Link href="/" className="font-semibold">
            Kanban
          </Link>
          <Link href="/search" className="text-sm underline-offset-4 hover:underline">
            Search
          </Link>
        </nav>
        <div className="flex items-center gap-3 text-sm">
          <span>{user.name}</span>
          <LogoutButton />
        </div>
      </header>
      <div id="main" className="flex-1">
        {children}
      </div>
    </div>
  );
}
