'use client';

import type { HighlightedText, SearchResult } from '@kanban/shared';
import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/shared/ui/button';
import { Field } from '@/shared/ui/field';
import { useSearch } from '../api/search';
import { useDebounced } from '../model/use-debounced';

/** Matches are rendered as <mark> elements built from data, never from HTML strings. */
const Highlighted = ({ parts }: { parts: HighlightedText }) => (
  <>
    {parts.map((part, index) =>
      part.match ? (
        <mark key={index} className="rounded bg-yellow-200 px-0.5 text-black">
          {part.text}
        </mark>
      ) : (
        <span key={index}>{part.text}</span>
      ),
    )}
  </>
);

const Result = ({ result }: { result: SearchResult }) => (
  <li className="rounded-md border border-border p-3">
    <Link
      className="font-medium underline-offset-2 hover:underline"
      href={`/boards/${result.boardId}/cards/${result.cardId}`}
      prefetch={false}
    >
      <Highlighted parts={result.cardTitle} />
    </Link>
    <p className="mt-0.5 text-xs text-muted-foreground">
      {result.kind === 'comment' ? 'Comment' : 'Card'}
    </p>
    <p className="mt-1 text-sm">
      <Highlighted parts={result.snippet} />
    </p>
  </li>
);

export const SearchView = ({ workspaces }: { workspaces: { id: string; name: string }[] }) => {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? '');
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 300);
  const search = useSearch(workspaceId, q);
  const results = search.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="grid gap-4">
      <form
        role="search"
        className="grid gap-3 sm:grid-cols-[1fr_auto]"
        onSubmit={(event) => event.preventDefault()}
      >
        <Field label="Search cards and comments">
          {(control) => (
            <input
              {...control}
              type="search"
              value={text}
              onChange={(event) => setText(event.target.value)}
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="Workspace">
          {(control) => (
            <select
              {...control}
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      </form>
      <div aria-live="polite">
        {q.length === 0 ? <p className="text-sm text-muted-foreground">Type to search.</p> : null}
        {search.isPending && q.length > 0 ? (
          <p className="text-sm text-muted-foreground" aria-busy="true">
            Searching…
          </p>
        ) : null}
        {search.isError ? (
          <p role="alert" className="text-sm text-danger">
            The search failed.{' '}
            <button className="underline" onClick={() => void search.refetch()}>
              Try again
            </button>
          </p>
        ) : null}
        {search.isSuccess && results.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing found for “{q}”.</p>
        ) : null}
      </div>
      <ul className="grid gap-2">
        {results.map((result) => (
          <Result key={`${result.kind}-${result.commentId ?? result.cardId}`} result={result} />
        ))}
      </ul>
      {search.hasNextPage ? (
        <Button
          variant="outline"
          onClick={() => void search.fetchNextPage()}
          disabled={search.isFetchingNextPage}
        >
          {search.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
    </div>
  );
};
