'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { registerBodySchema, type RegisterBody } from '@kanban/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { api, describeError, isApiError } from '@/shared/lib/client-api';
import { Button } from '@/shared/ui/button';
import { Field } from '@/shared/ui/field';

export const RegisterForm = ({ next }: { next: string }) => {
  const router = useRouter();
  const [formError, setFormError] = useState<string>();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterBody>({ resolver: zodResolver(registerBodySchema) });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(undefined);
    try {
      await api('/auth/register', { json: values });
      router.replace(next);
      router.refresh();
    } catch (error) {
      // The server tells us which field is already taken; show it next to that field.
      const field = isApiError(error) && error.status === 409 ? error.details?.field : undefined;
      if (field === 'email' || field === 'handle')
        setError(field, { message: `This ${field} is already taken.` });
      else setFormError(describeError(error));
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" aria-label="Create account">
      <Field label="Name" error={errors.name?.message}>
        {(control) => <input {...control} {...register('name')} autoComplete="name" />}
      </Field>
      <Field label="Email" error={errors.email?.message}>
        {(control) => (
          <input {...control} {...register('email')} type="email" autoComplete="email" />
        )}
      </Field>
      <Field
        label="Handle"
        hint="Used for @mentions: 3-32 letters, digits, '.', '_' or '-'."
        error={errors.handle?.message}
      >
        {(control) => <input {...control} {...register('handle')} autoComplete="username" />}
      </Field>
      <Field label="Password" hint="At least 8 characters." error={errors.password?.message}>
        {(control) => (
          <input
            {...control}
            {...register('password')}
            type="password"
            autoComplete="new-password"
          />
        )}
      </Field>
      {formError ? (
        <p role="alert" className="text-sm text-danger">
          {formError}
        </p>
      ) : null}
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Creating…' : 'Create account'}
      </Button>
      <p className="text-sm text-muted-foreground">
        Already registered?{' '}
        <Link
          prefetch={false}
          className="underline"
          href={`/login?next=${encodeURIComponent(next)}`}
        >
          Sign in
        </Link>
      </p>
    </form>
  );
};
