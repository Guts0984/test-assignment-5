'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { renameBoardBodySchema, type BoardSnapshot } from '@kanban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { api, describeError } from '@/shared/lib/client-api';
import { Button } from '@/shared/ui/button';
import { Modal } from '@/shared/ui/dialog';
import { Field } from '@/shared/ui/field';

import { boardKey } from '../api/keys';
import { markDeletedHere } from '../model/deleted-here';

type Values = z.infer<typeof renameBoardBodySchema>;

const RenameForm = ({
  boardId,
  currentName,
  onDone,
}: {
  boardId: string;
  currentName: string;
  onDone: (name: string) => void;
}) => {
  const [formError, setFormError] = useState<string>();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(renameBoardBodySchema),
    defaultValues: { name: currentName },
  });
  const onSubmit = handleSubmit(async (values) => {
    setFormError(undefined);
    try {
      const board = await api<{ name: string }>(`/boards/${boardId}`, {
        method: 'PATCH',
        json: values,
      });
      onDone(board.name);
    } catch (error) {
      setFormError(describeError(error));
    }
  });
  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" aria-label="Rename board">
      <Field label="Board name" error={errors.name?.message}>
        {(control) => <input {...control} {...register('name')} autoComplete="off" />}
      </Field>
      {formError ? (
        <p role="alert" className="text-sm text-danger">
          {formError}
        </p>
      ) : null}
      <Button type="submit" disabled={isSubmitting} className="justify-self-start">
        {isSubmitting ? 'Saving…' : 'Save name'}
      </Button>
    </form>
  );
};

/** Rename and delete, shown only to people the server would let do it (`board.canManage`). */
export const BoardMenu = ({ board }: { board: BoardSnapshot['board'] }) => {
  const router = useRouter();
  const client = useQueryClient();
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  if (!board.canManage) return null;

  const remove = async () => {
    setDeleting(true);
    setDeleteError(undefined);
    markDeletedHere(board.id);
    try {
      await api(`/boards/${board.id}`, { method: 'DELETE' });
      setDialog(null);
      router.replace('/');
      router.refresh();
    } catch (error) {
      setDeleteError(describeError(error));
      setDeleting(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setDialog('rename')}>
        <Pencil className="h-4 w-4" aria-hidden /> Rename
      </Button>
      <Button variant="outline" size="sm" onClick={() => setDialog('delete')}>
        <Trash2 className="h-4 w-4" aria-hidden /> Delete
      </Button>
      {dialog === 'rename' ? (
        <Modal title="Rename board" onClose={() => setDialog(null)}>
          <RenameForm
            boardId={board.id}
            currentName={board.name}
            onDone={(name) => {
              client.setQueryData<BoardSnapshot>(boardKey(board.id), (current) =>
                current ? { ...current, board: { ...current.board, name } } : current,
              );
              setDialog(null);
            }}
          />
        </Modal>
      ) : null}
      {dialog === 'delete' ? (
        <Modal title="Delete board" onClose={() => setDialog(null)}>
          <div className="grid gap-4">
            <p>
              Delete <strong>{board.name}</strong> with all of its cards, comments and files? This
              cannot be undone.
            </p>
            {deleteError ? (
              <p role="alert" className="text-sm text-danger">
                {deleteError}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button variant="danger" onClick={() => void remove()} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete board'}
              </Button>
              <Button variant="outline" onClick={() => setDialog(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
};
