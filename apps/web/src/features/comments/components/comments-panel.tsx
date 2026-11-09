'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { createCommentBodySchema, type Comment, type CreateCommentBody } from '@kanban/shared';
import { useForm } from 'react-hook-form';

import { Button } from '@/shared/ui/button';
import { Field, TextArea } from '@/shared/ui/field';
import { useAddComment, useComments } from '../api/comments';
import { splitMentions } from '../model/mentions';

const CommentBody = ({ comment }: { comment: Comment }) => (
  <p className="whitespace-pre-wrap break-words text-sm">
    {splitMentions(
      comment.body,
      comment.mentions.map((mention) => mention.handle),
    ).map((part, index) =>
      part.mention ? (
        <strong key={index} className="rounded bg-primary/10 px-0.5 text-primary">
          {part.text}
        </strong>
      ) : (
        <span key={index}>{part.text}</span>
      ),
    )}
  </p>
);

export const CommentsPanel = ({ cardId, canComment }: { cardId: string; canComment: boolean }) => {
  const comments = useComments(cardId);
  const add = useAddComment(cardId);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateCommentBody>({ resolver: zodResolver(createCommentBodySchema) });

  return (
    <section aria-labelledby={`comments-${cardId}`} className="grid gap-3">
      <h3 id={`comments-${cardId}`} className="font-semibold">
        Comments
      </h3>
      {comments.isPending ? (
        <p className="text-sm text-muted-foreground" aria-busy="true">
          Loading comments…
        </p>
      ) : null}
      {comments.isError ? (
        <p role="alert" className="text-sm text-danger">
          Comments could not be loaded.{' '}
          <button className="underline" onClick={() => void comments.refetch()}>
            Retry
          </button>
        </p>
      ) : null}
      {comments.data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet.</p>
      ) : null}
      <ul className="grid gap-3">
        {comments.data?.map((comment) => (
          <li key={comment.id} className="rounded-md border border-border p-3">
            <p className="mb-1 text-xs text-muted-foreground">
              {comment.author.name} ·{' '}
              <time dateTime={comment.createdAt}>
                {new Date(comment.createdAt).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC
              </time>
            </p>
            <CommentBody comment={comment} />
          </li>
        ))}
      </ul>
      {canComment ? (
        <form
          noValidate
          onSubmit={handleSubmit((values) => add.mutate(values.body, { onSuccess: () => reset() }))}
          className="grid gap-2"
        >
          <Field
            label="Add a comment"
            hint="Mention a teammate with @handle."
            error={errors.body?.message}
          >
            {(control) => <TextArea {...control} {...register('body')} rows={3} />}
          </Field>
          <Button type="submit" disabled={add.isPending} className="justify-self-start">
            {add.isPending ? 'Posting…' : 'Comment'}
          </Button>
        </form>
      ) : null}
    </section>
  );
};
