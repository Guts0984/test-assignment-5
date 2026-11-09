'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginBodySchema, type LoginBody } from '@kanban/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { api, describeError, isApiError } from '@/shared/lib/client-api';
import { Button } from '@/shared/ui/button';
import { Field } from '@/shared/ui/field';

export const LoginForm = ({ next }: { next: string }) => {
  const router = useRouter();
  const [formError, setFormError] = useState<string>();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginBody>({ resolver: zodResolver(loginBodySchema) });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(undefined);
    try {
      await api('/auth/login', { json: values });
      router.replace(next);
      router.refresh();
    } catch (error) {
      setFormError(
        isApiError(error) && error.status === 401
          ? 'The email or password is not correct.'
          : describeError(error),
      );
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" aria-label="Sign in">
      <Field label="Email" error={errors.email?.message}>
        {(control) => (
          <input {...control} {...register('email')} type="email" autoComplete="email" />
        )}
      </Field>
      <Field label="Password" error={errors.password?.message}>
        {(control) => (
          <input
            {...control}
            {...register('password')}
            type="password"
            autoComplete="current-password"
          />
        )}
      </Field>
      {formError ? (
        <p role="alert" className="text-sm text-danger">
          {formError}
        </p>
      ) : null}
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Signing in…' : 'Sign in'}
      </Button>
      <p className="text-sm text-muted-foreground">
        No account?{' '}
        <Link
          prefetch={false}
          className="underline"
          href={`/register?next=${encodeURIComponent(next)}`}
        >
          Create one
        </Link>
      </p>
    </form>
  );
};
