import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { boardKey } from '@/features/boards/api/keys';
import { CardDetail } from '@/features/cards';
import { board, card, cardId, ids } from './support/fixtures';
import { server } from './support/msw';

const T = '2026-01-02T00:00:00.000Z';

const renderDetail = (role: 'editor' | 'viewer' = 'editor') => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(boardKey(ids.board), board(role));
  server.use(
    http.get('http://localhost/api/cards/:id/comments', () => HttpResponse.json([])),
    http.get('http://localhost/api/cards/:id/attachments', () => HttpResponse.json([])),
  );
  const onDeleted = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <CardDetail boardId={ids.board} cardId={cardId(1)} onDeleted={onDeleted} />
    </QueryClientProvider>,
  );
  return { onDeleted };
};

const conflict = (theirs: Partial<ReturnType<typeof card>>) =>
  HttpResponse.json(
    {
      error: {
        code: 'version_conflict',
        message: 'This card was changed by someone else',
        details: { current: card(1, { version: 2, updatedAt: T, ...theirs }) },
      },
    },
    { status: 409 },
  );

describe('editing a card that someone else changed', () => {
  it('shows their version, keeps what I typed, and lets me save mine on top', async () => {
    const bodies: { version: number; title: string; description: string }[] = [];
    server.use(
      http.patch('http://localhost/api/cards/:id', async ({ request }) => {
        const body = (await request.json()) as (typeof bodies)[number];
        bodies.push(body);
        if (body.version === 1)
          return conflict({ title: 'Their title', description: 'Their description' });
        return HttpResponse.json(
          card(1, { title: body.title, description: body.description, version: 3, updatedAt: T }),
        );
      }),
    );
    renderDetail();
    const user = userEvent.setup();

    const title = screen.getByLabelText('Title');
    const description = screen.getByLabelText('Description');
    await user.clear(title);
    await user.type(title, 'My title');
    await user.type(description, 'My long description that took a while to write');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByText(/Someone else changed this card/);
    const panel = alert.closest('[role="alert"]') as HTMLElement;
    expect(within(panel).getByText('Their title')).toBeInTheDocument(); // their version is shown
    expect(within(panel).getByText('Their description')).toBeInTheDocument();
    expect(title).toHaveValue('My title'); // and nothing I typed was lost
    expect(description).toHaveValue('My long description that took a while to write');

    await user.click(within(panel).getByRole('button', { name: 'Save mine over theirs' }));
    await waitFor(() =>
      expect(screen.queryByText(/Someone else changed this card/)).not.toBeInTheDocument(),
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({
      version: 2,
      title: 'My title',
      description: 'My long description that took a while to write',
    }); // based on THEIR version
  });

  it('lets me take their version instead, replacing the form with it', async () => {
    server.use(
      http.patch('http://localhost/api/cards/:id', () =>
        conflict({ title: 'Their title', description: 'Theirs' }),
      ),
    );
    renderDetail();
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'Mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: 'Use their version' }));
    expect(screen.getByLabelText('Title')).toHaveValue('Their title');
    expect(screen.getByLabelText('Description')).toHaveValue('Theirs');
    expect(screen.queryByText(/Someone else changed this card/)).not.toBeInTheDocument();
  });

  it('keeps the typed text when saving fails for another reason, and says why', async () => {
    server.use(
      http.patch('http://localhost/api/cards/:id', () =>
        HttpResponse.json({ error: { code: 'forbidden', message: 'no' } }, { status: 403 }),
      ),
    );
    renderDetail();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Description'), 'important text');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/do not have permission/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toHaveValue('important text');
  });
});

describe('the form itself', () => {
  it('ties each error to its field for keyboard and screen reader users', async () => {
    renderDetail();
    const user = userEvent.setup();
    const title = screen.getByLabelText('Title');
    await user.clear(title);
    await user.type(screen.getByLabelText('Description'), 'x'); // make the form dirty so Save is enabled
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const message = await screen.findByText(/too small|at least 1|Too small/i);
    expect(title).toHaveAttribute('aria-invalid', 'true');
    expect(title.getAttribute('aria-describedby')).toBe(message.id);
    expect(message).toHaveAttribute('role', 'alert');
  });

  it('is read-only for a viewer, who sees no Save or Delete', () => {
    renderDetail('viewer');
    expect(screen.getByLabelText('Title')).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete card' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Add a comment')).not.toBeInTheDocument();
  });
});
