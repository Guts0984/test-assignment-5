import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { PendingInvites } from '@/features/workspaces';
import { ids } from './support/fixtures';
import { server } from './support/msw';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const invite = {
  id: ids.user,
  workspaceId: ids.board,
  workspaceName: 'Acme',
  role: 'editor' as const,
  invitedBy: 'Alice',
  expiresAt: '2026-12-01T00:00:00.000Z',
};

describe('invitations shown inside the app', () => {
  it('shows nothing when there are none', () => {
    const { container } = render(<PendingInvites invites={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists who invited me to what, and accepting joins and refreshes the page', async () => {
    let accepted = '';
    server.use(
      http.post('http://localhost/api/me/invites/:id/accept', ({ params }) => {
        accepted = String(params.id);
        return HttpResponse.json({ workspaceId: ids.board, role: 'editor' });
      }),
    );
    render(<PendingInvites invites={[invite]} />);
    expect(screen.getByText(/Acme/)).toBeInTheDocument();
    expect(screen.getByText(/invited by Alice/)).toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Accept the invitation to Acme' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(accepted).toBe(ids.user);
  });

  it('says why it failed and lets me try again', async () => {
    server.use(
      http.post('http://localhost/api/me/invites/:id/accept', () =>
        HttpResponse.json({ error: { code: 'not_found', message: 'x' } }, { status: 404 }),
      ),
    );
    render(<PendingInvites invites={[invite]} />);
    const button = screen.getByRole('button', { name: /Accept the invitation/ });
    await userEvent.setup().click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer exists/i);
    expect(button).toBeEnabled();
  });
});
