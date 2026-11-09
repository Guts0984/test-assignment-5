'use client';

import Link from 'next/link';

import { Button } from '@/shared/ui/button';

export default function BoardError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto grid max-w-md gap-4 p-8 text-center">
      <h1 className="text-xl font-semibold">The board could not be loaded</h1>
      <div className="flex justify-center gap-3">
        <Button onClick={reset}>Try again</Button>
        <Button variant="outline" asChild>
          <Link prefetch={false} href="/">
            Your boards
          </Link>
        </Button>
      </div>
    </div>
  );
}
