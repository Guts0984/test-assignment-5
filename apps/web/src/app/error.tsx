'use client';

import { Button } from '@/shared/ui/button';

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main id="main" className="mx-auto grid max-w-md gap-4 p-8 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground">The page could not be loaded. Your data is safe.</p>
      <Button onClick={reset}>Try again</Button>
    </main>
  );
}
