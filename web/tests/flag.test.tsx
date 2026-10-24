import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError, type UserApi } from '../src/lib/api';
import { NotificationsSection } from '../src/components/NotificationsSection';

const mockApi = vi.hoisted(() => ({
  me: vi.fn(),
  setNotifications: vi.fn(),
}));

vi.mock('../src/lib/ApiContext', () => ({
  useApi: () => mockApi as unknown as UserApi,
}));

function meOn(on: boolean, until: string | null = '2026-01-01T18:00:00Z') {
  return {
    notify_on_phone: on,
    phone_alerts_since: on ? '2026-01-01T10:00:00Z' : null,
    until: on ? until : null,
    email: 'u@example.com',
    active_device_count: 1,
    machine_count: 1,
  };
}

describe('phone alerts switch', () => {
  it('loads and shows the server state', async () => {
    mockApi.me.mockResolvedValue(meOn(false));
    render(<NotificationsSection />);
    expect(await screen.findByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('alert-status')).toHaveTextContent('Alerts off');
  });

  it('shows the server value after a successful PUT', async () => {
    mockApi.me.mockResolvedValue(meOn(false));
    mockApi.setNotifications.mockResolvedValue({
      notify_on_phone: true,
      phone_alerts_since: '2026-01-01T10:00:00Z',
      until: '2026-01-01T18:00:00Z',
    });
    render(<NotificationsSection />);
    const sw = await screen.findByRole('switch');
    await waitFor(() => expect(sw).toBeEnabled());
    await userEvent.click(sw);
    expect(mockApi.setNotifications).toHaveBeenCalledWith(true);
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByTestId('alert-status')).toHaveTextContent(/Alerts on until \d{2}:\d{2}/);
  });

  it('keeps the server value and shows the error category after a failed PUT', async () => {
    mockApi.me.mockResolvedValue(meOn(false));
    mockApi.setNotifications.mockRejectedValue(new ApiError(429, 'rate_limited', 'slow down'));
    render(<NotificationsSection />);
    const sw = await screen.findByRole('switch');
    await waitFor(() => expect(sw).toBeEnabled());
    await userEvent.click(sw);
    await screen.findByRole('alert');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('alert')).toHaveTextContent('rate_limited');
    expect(screen.getByTestId('alert-status')).toHaveTextContent('Alerts off');
  });
});
