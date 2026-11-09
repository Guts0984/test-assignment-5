'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { isApiError } from '../lib/client-api';
import { Toaster } from './toaster';

export const makeQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // A refused or missing request will not succeed on retry; only transient failures do.
        retry: (count, error) =>
          isApiError(error) && error.status > 0 && error.status < 500 ? false : count < 2,
        refetchOnWindowFocus: false,
      },
    },
  });

export const Providers = ({ children }: { children: ReactNode }) => {
  const [client] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={client}>
      {children}
      <Toaster />
    </QueryClientProvider>
  );
};
