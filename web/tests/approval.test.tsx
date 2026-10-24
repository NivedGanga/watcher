import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ApiError, type UserApi } from '../src/lib/api';
import { ApprovalPage } from '../src/pages/ApprovalPage';

const mockApi = vi.hoisted(() => ({
  pendingApproval: vi.fn(),
  approveDevice: vi.fn(),
  denyDevice: vi.fn(),
}));

const mockAuth = vi.hoisted(() => ({
  user: { email: 'owner@example.com' },
  loading: false,
  error: null,
  signIn: vi.fn(),
  signOut: vi.fn(),
  deleteAccount: vi.fn(),
  getIdToken: vi.fn(),
}));

vi.mock('../src/lib/ApiContext', () => ({
  useApi: () => mockApi as unknown as UserApi,
}));
vi.mock('../src/auth/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

const pending = {
  user_code: 'XKCD-9W2P',
  client_name: 'workstation',
  client_os: 'macos',
  expires_at: '2026-01-01T10:10:00Z',
};

function renderApproval(initial = '/device?user_code=xkcd9w2p') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <ApprovalPage />
    </MemoryRouter>,
  );
}

describe('approval page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.user = { email: 'owner@example.com' } as never;
    mockAuth.loading = false;
  });

  it('normalizes the code to XXXX-XXXX and looks it up', async () => {
    mockApi.pendingApproval.mockResolvedValue(pending);
    renderApproval('/device?user_code=xkcd 9w-2p');
    const input = await screen.findByLabelText(/code shown by the cli/i);
    expect(input).toHaveValue('XKCD-9W2P');
    await waitFor(() => expect(mockApi.pendingApproval).toHaveBeenCalledWith('XKCD-9W2P'));
    expect(await screen.findByText('workstation')).toBeInTheDocument();
    expect(screen.getByText('macos')).toBeInTheDocument();
    expect(screen.getByText('owner@example.com')).toBeInTheDocument();
  });

  it('shows the only-approve warning', async () => {
    mockApi.pendingApproval.mockResolvedValue(pending);
    renderApproval();
    expect(
      await screen.findByText(/Only approve if you just ran.*on this computer/i),
    ).toBeInTheDocument();
  });

  it('approves with the formatted code and shows the done message', async () => {
    mockApi.pendingApproval.mockResolvedValue(pending);
    mockApi.approveDevice.mockResolvedValue({ approved: true });
    renderApproval();
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(mockApi.approveDevice).toHaveBeenCalledWith('XKCD-9W2P');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Computer connected. You can close this page.',
    );
  });

  it('denies with the formatted code', async () => {
    mockApi.pendingApproval.mockResolvedValue(pending);
    mockApi.denyDevice.mockResolvedValue({ approved: false });
    renderApproval();
    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    expect(mockApi.denyDevice).toHaveBeenCalledWith('XKCD-9W2P');
    expect(await screen.findByRole('status')).toHaveTextContent('Denied');
  });

  it('shows a not-found/expired message on 404', async () => {
    mockApi.pendingApproval.mockRejectedValue(new ApiError(404, 'not_found', 'nope'));
    renderApproval();
    expect(await screen.findByRole('alert')).toHaveTextContent(/wasn't found.*expired/i);
  });

  it('shows a message for an invalid code shape', async () => {
    mockApi.pendingApproval.mockRejectedValue(new ApiError(400, 'validation_failed', 'bad'));
    renderApproval('/device?user_code=ABCDEFGH');
    expect(await screen.findByRole('alert')).toHaveTextContent(/not a valid code/i);
  });

  it('requires sign-in', async () => {
    mockAuth.user = null as never;
    renderApproval();
    expect(await screen.findByRole('button', { name: /sign in with google/i })).toBeInTheDocument();
    expect(mockApi.pendingApproval).not.toHaveBeenCalled();
  });
});
