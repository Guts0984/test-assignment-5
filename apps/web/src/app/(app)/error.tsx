'use client';

import { Button } from '@/shared/ui/button';

export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto grid max-w-md gap-4 p-8 text-center">
      <h1 className="text-xl font-semibold">This page could not be loaded</h1>
      <p className="text-muted-foreground">The rest of the app is unaffected.</p>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
