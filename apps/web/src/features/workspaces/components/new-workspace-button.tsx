'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { createWorkspaceBodySchema, type WorkspaceSummary } from '@kanban/shared';
import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { api, describeError } from '@/shared/lib/client-api';
import { Button } from '@/shared/ui/button';
import { Modal } from '@/shared/ui/dialog';
import { Field } from '@/shared/ui/field';
import { toast } from '@/shared/ui/toaster';

type Values = z.infer<typeof createWorkspaceBodySchema>;

const NewWorkspaceForm = ({ onCreated }: { onCreated: (workspace: WorkspaceSummary) => void }) => {
  const [formError, setFormError] = useState<string>();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(createWorkspaceBodySchema),
    defaultValues: { name: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(undefined);
    try {
      onCreated(await api<WorkspaceSummary>('/workspaces', { json: values }));
    } catch (error) {
      setFormError(describeError(error));
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" aria-label="New workspace">
      <p className="text-sm text-muted-foreground">
        You will be the owner: you can create boards, invite people and set their roles.
      </p>
      <Field label="Workspace name" error={errors.name?.message}>
        {(control) => <input {...control} {...register('name')} autoComplete="off" />}
      </Field>
      {formError ? (
        <p role="alert" className="text-sm text-danger">
          {formError}
        </p>
      ) : null}
      <Button type="submit" disabled={isSubmitting} className="justify-self-start">
        {isSubmitting ? 'Creating…' : 'Create workspace'}
      </Button>
    </form>
  );
};

/** Open to every signed-in user: roles are per workspace, so anyone can start one of their own. */
export const NewWorkspaceButton = () => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden /> New workspace
      </Button>
      {open ? (
        <Modal title="New workspace" onClose={() => setOpen(false)}>
          <NewWorkspaceForm
            onCreated={(workspace) => {
              setOpen(false);
              toast(`Workspace “${workspace.name}” created.`, 'success');
              router.refresh();
            }}
          />
        </Modal>
      ) : null}
    </>
  );
};
