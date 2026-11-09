'use client';

import { LIMITS } from '@kanban/shared';
import { useState } from 'react';

import { Button } from '@/shared/ui/button';
import { useCreateCard } from '../api/create-card';

export const AddCardForm = ({
  boardId,
  columnId,
  columnName,
}: {
  boardId: string;
  columnId: string;
  columnName: string;
}) => {
  const [title, setTitle] = useState('');
  const create = useCreateCard(boardId);
  const clean = title.trim();
  return (
    <form
      className="flex gap-2 border-t border-border p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!clean) return;
        create.mutate({ columnId, title: clean }, { onSuccess: () => setTitle('') });
      }}
    >
      <label className="sr-only" htmlFor={`new-card-${columnId}`}>
        New card in {columnName}
      </label>
      <input
        id={`new-card-${columnId}`}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        maxLength={LIMITS.cardTitle}
        placeholder="Add a card"
        className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
      />
      <Button type="submit" size="sm" disabled={!clean || create.isPending}>
        Add
      </Button>
    </form>
  );
};
