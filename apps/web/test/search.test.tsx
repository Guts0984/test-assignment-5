import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { useSearch } from '@/features/search/api/search';
import { SearchView } from '@/features/search';
import { ids } from './support/fixtures';
import { server } from './support/msw';

const page = (title: string) => ({
  items: [
    {
      kind: 'card',
      boardId: ids.board,
      cardId: '44444444-4444-4444-8444-000000000001',
      commentId: null,
      cardTitle: [{ text: title, match: true }],
      snippet: [{ text: 'snippet', match: false }],
      rank: 1,
    },
  ],
  nextCursor: null,
});
const provider = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
};

describe('search answers that arrive out of order', () => {
  it('an old, slow answer never replaces the answer to the newer question', async () => {
    server.use(
      http.get('http://localhost/api/search', async ({ request }) => {
        const q = new URL(request.url).searchParams.get('q');
        if (q === 'ab') {
          await delay(250); // the first question is answered LAST
          return HttpResponse.json(page('OLD answer'));
        }
        await delay(10);
        return HttpResponse.json(page('NEW answer'));
      }),
    );
    const { result, rerender } = renderHook(({ q }: { q: string }) => useSearch(ids.board, q), {
      wrapper: provider(),
      initialProps: { q: 'ab' },
    });
    rerender({ q: 'abc' }); // the user typed one more letter

    await waitFor(() =>
      expect(result.current.data?.pages[0]?.items[0]?.cardTitle[0]?.text).toBe('NEW answer'),
    );
    await new Promise((resolve) => setTimeout(resolve, 400)); // long enough for the old answer to have arrived
    expect(result.current.data?.pages[0]?.items[0]?.cardTitle[0]?.text).toBe('NEW answer');
  });

  it('does not search at all for an empty query', async () => {
    let calls = 0;
    server.use(
      http.get('http://localhost/api/search', () => {
        calls += 1;
        return HttpResponse.json(page('x'));
      }),
    );
    renderHook(() => useSearch(ids.board, ''), { wrapper: provider() });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toBe(0);
  });
});

describe('the search screen', () => {
  it('waits for typing to pause, shows highlighted matches as marks, and handles no results and errors', async () => {
    const queries: string[] = [];
    server.use(
      http.get('http://localhost/api/search', ({ request }) => {
        const q = new URL(request.url).searchParams.get('q') ?? '';
        queries.push(q);
        if (q === 'none') return HttpResponse.json({ items: [], nextCursor: null });
        if (q === 'boom')
          return HttpResponse.json(
            { error: { code: 'internal_error', message: 'x' } },
            { status: 500 },
          );
        return HttpResponse.json(page('Deploy'));
      }),
    );
    render(<SearchView workspaces={[{ id: ids.board, name: 'Acme' }]} />, { wrapper: provider() });
    const user = userEvent.setup();
    const input = screen.getByLabelText('Search cards and comments');

    await user.type(input, 'deploy');
    expect(queries).toEqual([]); // still typing: nothing sent yet
    const mark = await screen.findByText('Deploy', { selector: 'mark' }, { timeout: 2000 });
    expect(mark.tagName).toBe('MARK');
    expect(queries).toEqual(['deploy']); // ONE request, not six

    await user.clear(input);
    await user.type(input, 'none');
    expect(
      await screen.findByText(/Nothing found for/, undefined, { timeout: 2000 }),
    ).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, 'boom');
    expect(
      await screen.findByText(/The search failed/, undefined, { timeout: 4000 }),
    ).toBeInTheDocument();
  });
});
