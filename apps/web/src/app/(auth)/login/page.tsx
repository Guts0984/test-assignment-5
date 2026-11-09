import { LoginForm, safeNext } from '@/features/auth';

export const metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  return (
    <main id="main" className="mx-auto grid max-w-sm gap-6 p-8">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <LoginForm next={safeNext(next)} />
    </main>
  );
}
