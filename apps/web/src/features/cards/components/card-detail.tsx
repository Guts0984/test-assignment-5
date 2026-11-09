'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import type { BoardSnapshot, Card } from '@kanban/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';

import { AttachmentsPanel } from '@/features/attachments';
import { boardKey } from '@/features/boards';
import { CommentsPanel } from '@/features/comments';
import { useRealtime } from '@/features/realtime';
import { describeError } from '@/shared/lib/client-api';
import { Button } from '@/shared/ui/button';
import { Field, TextArea } from '@/shared/ui/field';
import { toast } from '@/shared/ui/toaster';
import { useDeleteCard, useUpdateCard } from '../api/card-mutations';
import { conflictingCard } from '../model/conflict';
import { editCardSchema, type EditCardValues } from '../model/edit-schema';

type Props = { boardId: string; cardId: string; onDeleted: () => void };

const Conflict = ({
  theirs,
  onKeepMine,
  onTakeTheirs,
  busy,
}: {
  theirs: Card;
  onKeepMine: () => void;
  onTakeTheirs: () => void;
  busy: boolean;
}) => (
  <div role="alert" className="grid gap-3 rounded-md border border-danger p-4">
    <p className="font-medium">Someone else changed this card while you were editing.</p>
    <p className="text-sm text-muted-foreground">
      Your text is still in the form below and has not been lost. Their version:
    </p>
    <div className="rounded bg-muted p-3 text-sm">
      <p className="font-medium">{theirs.title}</p>
      <p className="mt-1 whitespace-pre-wrap">{theirs.description || <em>(no description)</em>}</p>
    </div>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" onClick={onKeepMine} disabled={busy}>
        Save mine over theirs
      </Button>
      <Button size="sm" variant="outline" onClick={onTakeTheirs} disabled={busy}>
        Use their version
      </Button>
    </div>
  </div>
);

/**
 * Card editor, shown in a modal over the board or as a page of its own. The form is the source of
 * truth while editing: a conflict, a refresh or a message from another user never overwrites what
 * has been typed.
 */
export const CardDetail = ({ boardId, cardId, onDeleted }: Props) => {
  const board = useQuery<BoardSnapshot>({ queryKey: boardKey(boardId), enabled: false });
  const card = board.data?.cards.find((candidate) => candidate.id === cardId);
  const canEdit = board.data?.role !== 'viewer';
  const { setEditing } = useRealtime();

  const update = useUpdateCard(boardId, cardId);
  const remove = useDeleteCard(boardId, cardId);
  // The version the editor started from; moves forward only when a save succeeds or they accept theirs.
  const baseVersion = useRef(card?.version ?? 1);
  const [conflict, setConflict] = useState<Card | null>(null);
  const [formError, setFormError] = useState<string>();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<EditCardValues>({
    resolver: zodResolver(editCardSchema),
    defaultValues: { title: card?.title ?? '', description: card?.description ?? '' },
  });

  // Tell the board that this card is being edited, and stop when the editor closes.
  useEffect(() => {
    if (!canEdit) return;
    setEditing(cardId);
    return () => setEditing(null);
  }, [cardId, canEdit, setEditing]);

  const save = (version: number) =>
    handleSubmit((values) => {
      setFormError(undefined);
      update.mutate(
        { version, ...values },
        {
          onSuccess: (saved) => {
            baseVersion.current = saved.version;
            setConflict(null);
            reset({ title: saved.title, description: saved.description });
            toast('Saved.', 'success');
          },
          onError: (error) => {
            const theirs = conflictingCard(error);
            if (theirs)
              setConflict(theirs); // the form keeps the user's text
            else setFormError(describeError(error));
          },
        },
      );
    })();

  if (!card) {
    return (
      <p role="alert" className="text-sm text-danger">
        This card no longer exists, or it was deleted by someone else.
      </p>
    );
  }
  return (
    <div className="grid gap-6">
      {conflict ? (
        <Conflict
          theirs={conflict}
          busy={update.isPending}
          onKeepMine={() => {
            baseVersion.current = conflict.version; // now based on the winning version, so this save goes through
            void save(conflict.version);
          }}
          onTakeTheirs={() => {
            baseVersion.current = conflict.version;
            reset({ title: conflict.title, description: conflict.description });
            setConflict(null);
          }}
        />
      ) : null}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save(baseVersion.current);
        }}
        className="grid gap-4"
        aria-label="Edit card"
      >
        <Field label="Title" error={errors.title?.message}>
          {(control) => <input {...control} {...register('title')} readOnly={!canEdit} />}
        </Field>
        <Field label="Description" error={errors.description?.message}>
          {(control) => (
            <TextArea {...control} {...register('description')} rows={6} readOnly={!canEdit} />
          )}
        </Field>
        {formError ? (
          <p role="alert" className="text-sm text-danger">
            {formError}
          </p>
        ) : null}
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={update.isPending || (!isDirty && !conflict)}>
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm('Delete this card? This cannot be undone.'))
                  remove.mutate(undefined, {
                    onSuccess: onDeleted,
                    onError: (error) => toast(describeError(error), 'error'),
                  });
              }}
            >
              Delete card
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">You can view this card but not change it.</p>
        )}
      </form>
      <AttachmentsPanel cardId={cardId} canUpload={canEdit} />
      <CommentsPanel cardId={cardId} canComment={canEdit} />
    </div>
  );
};
