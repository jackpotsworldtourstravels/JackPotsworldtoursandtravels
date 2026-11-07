import { fireEvent, screen } from '@testing-library/react-native';

import { hotelApi, packageApi } from '@/api/endpoints/booking';
import { ApiError } from '@/api/errors';
import PaymentsScreen from '@/app/payments/index';

import { hotelBooking, packageBooking, payment } from '../fixtures/booking';
import { renderWithClient, resetNavigation, router, signInAsGuest, signOut } from '../helpers/mocks';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);
jest.mock('@/api/endpoints/booking', () => ({ hotelApi: { list: jest.fn() }, packageApi: { list: jest.fn() } }));

const hotel = hotelApi as jest.Mocked<typeof hotelApi>;
const pkg = packageApi as jest.Mocked<typeof packageApi>;
const at = (iso: string, status: Parameters<typeof payment>[0]) => ({ ...payment(status), created_at: iso, provider_reference: status === 'captured' ? 'pay_abc123' : null });

beforeEach(() => {
  hotel.list.mockReset().mockResolvedValue([]);
  pkg.list.mockReset().mockResolvedValue([]);
  resetNavigation({}, { pathname: '/payments', segments: ['payments'] });
});

describe('payments', () => {
  it('lists each attempt with the backend’s own status, an exact amount and its reference', async () => {
    hotel.list.mockResolvedValue([hotelBooking({ payments: [at('2026-10-20T09:00:00Z', 'captured')] })]);
    pkg.list.mockResolvedValue([packageBooking({ payments: [at('2026-10-21T09:00:00Z', 'failed')] })]);
    await renderWithClient(<PaymentsScreen />);

    expect(await screen.findByText('Paid')).toBeOnTheScreen();
    expect(screen.getByText('Not completed')).toBeOnTheScreen();
    expect(screen.getByText('Reference pay_abc123')).toBeOnTheScreen();
    expect(screen.getAllByText(/^₹/).length).toBe(2);
  });

  it('says plainly that a payment was refunded, and does not call it paid', async () => {
    hotel.list.mockResolvedValue([hotelBooking({ status: 'cancelled', payments: [at('2026-10-20T09:00:00Z', 'refunded')] })]);
    await renderWithClient(<PaymentsScreen />);
    expect(await screen.findByText('Refunded')).toBeOnTheScreen();
    expect(screen.getByText('This payment was refunded.')).toBeOnTheScreen();
    expect(screen.queryByText('Paid')).toBeNull();
  });

  it('shows a status it does not know as "Being checked" rather than guessing', async () => {
    hotel.list.mockResolvedValue([hotelBooking({ payments: [at('2026-10-20T09:00:00Z', 'partially_captured' as never)] })]);
    await renderWithClient(<PaymentsScreen />);
    expect(await screen.findByText('Being checked')).toBeOnTheScreen();
  });

  it('opens the booking a payment belongs to', async () => {
    hotel.list.mockResolvedValue([hotelBooking({ payments: [at('2026-10-20T09:00:00Z', 'captured')] })]);
    await renderWithClient(<PaymentsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^JPH000123/ }));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/booking/[ref]', params: { ref: 'JPH000123' } });
  });

  it('says so when nothing has been paid or attempted', async () => {
    hotel.list.mockResolvedValue([hotelBooking({ payments: [] })]);
    await renderWithClient(<PaymentsScreen />);
    expect(await screen.findByText('No payments yet')).toBeOnTheScreen();
  });

  it('offers a retry when it cannot load', async () => {
    hotel.list.mockRejectedValueOnce(new ApiError('network')).mockResolvedValue([]);
    await renderWithClient(<PaymentsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByText('No payments yet')).toBeOnTheScreen();
  });

  it('shows a guest the payments on their bookings, and asks a signed-out visitor to sign in without fetching anything', async () => {
    signInAsGuest();
    hotel.list.mockResolvedValue([hotelBooking({ payments: [at('2026-10-20T09:00:00Z', 'captured')] })]);
    const first = await renderWithClient(<PaymentsScreen />);
    expect(await screen.findByText('Paid')).toBeOnTheScreen();
    await first.result.unmount();

    hotel.list.mockClear();
    signOut();
    await renderWithClient(<PaymentsScreen />);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(hotel.list).not.toHaveBeenCalled();
  });
});
