import Link from 'next/link';

export default function NotFound() {
  return (
    <main id="main" className="mx-auto grid max-w-md gap-4 p-8 text-center">
      <h1 className="text-xl font-semibold">Not found</h1>
      <p className="text-muted-foreground">
        This page does not exist, or you do not have access to it.
      </p>
      <Link prefetch={false} href="/" className="underline">
        Back to your boards
      </Link>
    </main>
  );
}
