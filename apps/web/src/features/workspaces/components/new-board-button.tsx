'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { createBoardBodySchema, idSchema, type CreatedBoard } from '@kanban/shared';
import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { api, describeError } from '@/shared/lib/client-api';
import { Button } from '@/shared/ui/button';
import { Modal } from '@/shared/ui/dialog';
import { Field } from '@/shared/ui/field';

const schema = z.object({ workspaceId: idSchema, name: createBoardBodySchema.shape.name });
type Values = z.infer<typeof schema>;

type Workspace = { id: string; name: string };

const NewBoardForm = ({
  workspaces,
  onCreated,
}: {
  workspaces: Workspace[];
  onCreated: (board: CreatedBoard) => void;
}) => {
  const [formError, setFormError] = useState<string>();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { workspaceId: workspaces[0]?.id ?? '', name: '' },
  });

  const onSubmit = handleSubmit(async ({ workspaceId, name }) => {
    setFormError(undefined);
    try {
      onCreated(await api<CreatedBoard>(`/workspaces/${workspaceId}/boards`, { json: { name } }));
    } catch (error) {
      setFormError(describeError(error));
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" aria-label="New board">
      {workspaces.length > 1 ? (
        <Field label="Workspace" error={errors.workspaceId?.message}>
          {(control) => (
            <select {...control} {...register('workspaceId')}>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : (
        <p className="text-sm text-muted-foreground">
          In <strong>{workspaces[0]?.name}</strong>. It starts with the columns To do, In progress
          and Done.
        </p>
      )}
      <Field label="Board name" error={errors.name?.message}>
        {(control) => <input {...control} {...register('name')} autoComplete="off" />}
      </Field>
      {formError ? (
        <p role="alert" className="text-sm text-danger">
          {formError}
        </p>
      ) : null}
      <Button type="submit" disabled={isSubmitting} className="justify-self-start">
        {isSubmitting ? 'Creating…' : 'Create board'}
      </Button>
    </form>
  );
};

/**
 * The "New board" button next to the page heading. It opens a dialog to pick the workspace (only
 * those where the user may create boards) and name the board, then opens the new board.
 */
export const NewBoardButton = ({ workspaces }: { workspaces: Workspace[] }) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  if (workspaces.length === 0) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden /> New board
      </Button>
      {open ? (
        <Modal title="New board" onClose={() => setOpen(false)}>
          <NewBoardForm
            workspaces={workspaces}
            onCreated={(board) => {
              setOpen(false);
              router.push(`/boards/${board.id}`);
            }}
          />
        </Modal>
      ) : null}
    </>
  );
};
