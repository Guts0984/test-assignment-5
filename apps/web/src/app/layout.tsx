import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Providers } from '@/shared/ui/providers';

import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Kanban', template: '%s · Kanban' },
  description: 'Team kanban boards',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-background focus:p-2"
        >
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
