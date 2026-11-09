import { RegisterForm, safeNext } from '@/features/auth';

export const metadata = { title: 'Create account' };

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  return (
    <main id="main" className="mx-auto grid max-w-sm gap-6 p-8">
      <h1 className="text-2xl font-semibold">Create account</h1>
      <RegisterForm next={safeNext(next)} />
    </main>
  );
}
