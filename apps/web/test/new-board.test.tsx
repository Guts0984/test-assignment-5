import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { NewBoardButton } from '@/features/workspaces';
import { ids } from './support/fixtures';
import { server } from './support/msw';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));

const A = { id: ids.user, name: 'Acme' };
const B = { id: ids.board, name: 'Beta' };

describe('the New board button', () => {
  it('is not shown when the user may not create boards anywhere', () => {
    const { container } = render(<NewBoardButton workspaces={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens a dialog, creates the board in the chosen workspace and opens it', async () => {
    let seen = '';
    server.use(
      http.post('http://localhost/api/workspaces/:id/boards', async ({ request, params }) => {
        seen = `${String(params.id)} ${((await request.json()) as { name: string }).name}`;
        return HttpResponse.json(
          { id: ids.todo, workspaceId: String(params.id), name: 'Launch' },
          { status: 201 },
        );
      }),
    );
    render(<NewBoardButton workspaces={[A, B]} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /New board/ }));
    await user.selectOptions(screen.getByLabelText('Workspace'), B.id);
    await user.type(screen.getByLabelText('Board name'), 'Launch');
    await user.click(screen.getByRole('button', { name: 'Create board' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/boards/${ids.todo}`));
    expect(seen).toBe(`${B.id} Launch`);
  });

  it('with a single workspace there is nothing to choose; an empty name is refused with a message tied to the field', async () => {
    let calls = 0;
    server.use(
      http.post('http://localhost/api/workspaces/:id/boards', () => {
        calls += 1;
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    render(<NewBoardButton workspaces={[A]} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /New board/ }));
    expect(screen.queryByLabelText('Workspace')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create board' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Board name')).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(calls).toBe(0);
  });

  it('explains a refusal and keeps what was typed', async () => {
    server.use(
      http.post('http://localhost/api/workspaces/:id/boards', () =>
        HttpResponse.json({ error: { code: 'forbidden', message: 'no' } }, { status: 403 }),
      ),
    );
    render(<NewBoardButton workspaces={[A]} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /New board/ }));
    await user.type(screen.getByLabelText('Board name'), 'Mine');
    await user.click(screen.getByRole('button', { name: 'Create board' }));
    expect(await screen.findByText(/do not have permission/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Board name')).toHaveValue('Mine');
  });
});
