import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { NewWorkspaceButton } from '@/features/workspaces';
import { ids } from './support/fixtures';
import { server } from './support/msw';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

describe('the New workspace button', () => {
  it('is available to everyone, creates the workspace with the typed name and refreshes the page', async () => {
    let sent: unknown;
    server.use(
      http.post('http://localhost/api/workspaces', async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(
          { id: ids.board, name: 'My team', role: 'owner', boards: [] },
          { status: 201 },
        );
      }),
    );
    render(<NewWorkspaceButton />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /New workspace/ }));
    await user.type(screen.getByLabelText('Workspace name'), 'My team');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(sent).toEqual({ name: 'My team' });
  });

  it('refuses an empty name before sending anything, with the message tied to the field', async () => {
    let calls = 0;
    server.use(
      http.post('http://localhost/api/workspaces', () => {
        calls += 1;
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    render(<NewWorkspaceButton />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /New workspace/ }));
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Workspace name')).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(calls).toBe(0);
  });

  it('explains a server refusal (for example the rate limit) and keeps what was typed', async () => {
    refresh.mockClear();
    server.use(
      http.post('http://localhost/api/workspaces', () =>
        HttpResponse.json({ error: { code: 'rate_limited', message: 'slow' } }, { status: 429 }),
      ),
    );
    render(<NewWorkspaceButton />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /New workspace/ }));
    await user.type(screen.getByLabelText('Workspace name'), 'Keep me');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));
    expect(await screen.findByText(/Too many requests/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Workspace name')).toHaveValue('Keep me');
    expect(refresh).not.toHaveBeenCalled();
  });
});
