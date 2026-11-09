import Link from 'next/link';

export const metadata = { title: 'Too many requests' };

/**
 * Where a visitor lands when the API says they are asking too often. It makes no API call, so it
 * is cheap to serve however hard the visitor keeps asking, and it cannot send them in a loop.
 */
export default function SlowDownPage() {
  return (
    <main id="main" className="mx-auto grid max-w-md gap-4 p-8 text-center">
      <h1 className="text-xl font-semibold">Too many requests</h1>
      <p className="text-muted-foreground">
        You are sending requests faster than we allow. Wait a few seconds and try again.
      </p>
      <Link href="/" className="underline">
        Back to your boards
      </Link>
    </main>
  );
}
