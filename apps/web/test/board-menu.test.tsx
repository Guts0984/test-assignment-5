import type { BoardSnapshot } from '@kanban/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { BoardMenu, boardKey, wasDeletedHere } from '@/features/boards';
import { board as boardFixture, ids } from './support/fixtures';
import { server } from './support/msw';

const replace = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh, push: vi.fn() }),
}));

const setup = (canManage: boolean) => {
  const snapshot = boardFixture('owner');
  const board = { ...snapshot.board, canManage };
  const client = new QueryClient();
  client.setQueryData(boardKey(board.id), { ...snapshot, board });
  render(
    <QueryClientProvider client={client}>
      <BoardMenu board={board} />
    </QueryClientProvider>,
  );
  return { client, board };
};

describe('rename and delete on the board', () => {
  it('are not offered to someone who may not use them', () => {
    setup(false);
    expect(screen.queryByRole('button', { name: /Rename/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
  });

  it('renaming sends the new name and updates the title everywhere at once', async () => {
    let sent: unknown;
    server.use(
      http.patch('http://localhost/api/boards/:id', async ({ request, params }) => {
        sent = { id: params.id, ...((await request.json()) as object) };
        return HttpResponse.json({ id: ids.board, workspaceId: ids.user, name: 'Better name' });
      }),
    );
    const { client } = setup(true);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Rename/ }));
    const field = screen.getByLabelText('Board name');
    expect(field).toHaveValue('Roadmap');
    await user.clear(field);
    await user.type(field, 'Better name');
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() =>
      expect(client.getQueryData<BoardSnapshot>(boardKey(ids.board))?.board.name).toBe(
        'Better name',
      ),
    );
    expect(sent).toEqual({ id: ids.board, name: 'Better name' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a refused rename says why, keeps the dialog and the typed name, and changes nothing', async () => {
    server.use(
      http.patch('http://localhost/api/boards/:id', () =>
        HttpResponse.json({ error: { code: 'forbidden', message: 'no' } }, { status: 403 }),
      ),
    );
    const { client } = setup(true);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Rename/ }));
    const field = screen.getByLabelText('Board name');
    await user.clear(field);
    await user.type(field, 'Nope');
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText(/do not have permission/i)).toBeInTheDocument();
    expect(field).toHaveValue('Nope');
    expect(client.getQueryData<BoardSnapshot>(boardKey(ids.board))?.board.name).toBe('Roadmap');
  });

  it('an empty name is not sent', async () => {
    let calls = 0;
    server.use(
      http.patch('http://localhost/api/boards/:id', () => {
        calls += 1;
        return HttpResponse.json({});
      }),
    );
    setup(true);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Rename/ }));
    await user.clear(screen.getByLabelText('Board name'));
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Board name')).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(calls).toBe(0);
  });

  it('deleting asks first, names the board, and only deletes after confirmation', async () => {
    let deleted = 0;
    server.use(
      http.delete('http://localhost/api/boards/:id', () => {
        deleted += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    setup(true);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Delete/ }));
    expect(screen.getByText('Roadmap', { selector: 'strong' })).toBeInTheDocument();
    expect(deleted).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(deleted).toBe(0);

    await user.click(screen.getByRole('button', { name: /Delete/ }));
    await user.click(screen.getByRole('button', { name: 'Delete board' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    expect(deleted).toBe(1);
    expect(wasDeletedHere(ids.board)).toBe(true); // so the socket announcement shows no extra notice
  });

  it('a failed delete stays on the board and explains', async () => {
    replace.mockClear();
    server.use(
      http.delete('http://localhost/api/boards/:id', () =>
        HttpResponse.json({ error: { code: 'forbidden', message: 'no' } }, { status: 403 }),
      ),
    );
    setup(true);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Delete/ }));
    await user.click(screen.getByRole('button', { name: 'Delete board' }));
    expect(await screen.findByText(/do not have permission/i)).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete board' })).toBeEnabled();
  });
});
