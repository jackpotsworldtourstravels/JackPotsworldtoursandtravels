import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { hotelApi, packageApi, paymentsApi } from '@/api/endpoints/booking';
import { ApiError } from '@/api/errors';
import BookingScreen from '@/app/booking/[ref]';

import { checkout, hotelBooking, packageBooking, payment, reconcile } from '../fixtures/booking';
import { accountApi, resetAccountApi } from '../helpers/accountMock';
import { deferred, renderWithClient, resetNavigation, router } from '../helpers/mocks';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);
jest.mock('@/api/endpoints/account', () => require('../helpers/accountMock').accountApiModule);
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('@/api/endpoints/booking', () => ({
  hotelApi: { get: jest.fn(), checkout: jest.fn(), reconcile: jest.fn(), cancel: jest.fn() },
  packageApi: { get: jest.fn(), checkout: jest.fn(), reconcile: jest.fn(), cancel: jest.fn() },
  paymentsApi: { config: jest.fn() },
}));

const hotel = hotelApi as jest.Mocked<typeof hotelApi>;
const pkg = packageApi as jest.Mocked<typeof packageApi>;
const payments = paymentsApi as jest.Mocked<typeof paymentsApi>;

const paidBooking = hotelBooking({ status: 'confirmed', payments: [payment('captured')] });
const REQUEST = {
  cancellation_id: 'CXL-20261021-000007',
  booking_id: 'JPH000123',
  service_type: 'Hotel',
  reason: null,
  requested_date: '2026-10-21T10:00:00Z',
  status: 'requested',
};

beforeEach(() => {
  resetAccountApi();
  [hotel, pkg].forEach((api) => Object.values(api).forEach((fn) => (fn as jest.Mock).mockReset()));
  payments.config.mockReset().mockResolvedValue({ configured: true, provider: 'hdfc', key_id: 'SG6226', currency: 'INR', mode: 'real' });
  hotel.get.mockResolvedValue(hotelBooking());
  hotel.checkout.mockResolvedValue(checkout);
  hotel.reconcile.mockResolvedValue(reconcile());
  resetNavigation({ ref: 'JPH000123' }, { pathname: '/booking/JPH000123', segments: ['booking', '[ref]'] });
});

const ask = () => screen.findByRole('button', { name: 'Ask us to cancel this booking' });

describe('help with a booking', () => {
  it('always offers help, with the booking’s reference carried to the request', async () => {
    await renderWithClient(<BookingScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Get help with this booking' }));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/support/new', params: { ref: 'JPH000123' } });
  });

  it('carries a package booking’s reference too', async () => {
    resetNavigation({ ref: 'JPP000045' }, { pathname: '/booking/JPP000045', segments: ['booking', '[ref]'] });
    pkg.get.mockResolvedValue(packageBooking());
    await renderWithClient(<BookingScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Get help with this booking' }));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/support/new', params: { ref: 'JPP000045' } });
  });

  it('does not offer a cancellation REQUEST for an unpaid booking: the customer simply cancels it', async () => {
    await renderWithClient(<BookingScreen />);
    await screen.findByRole('button', { name: 'Get help with this booking' });
    expect(screen.queryByRole('button', { name: 'Ask us to cancel this booking' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel booking' })).toBeOnTheScreen();
  });

  it('offers one for a paid, confirmed booking, and says plainly that it cancels and refunds nothing by itself', async () => {
    hotel.get.mockResolvedValue(paidBooking);
    await renderWithClient(<BookingScreen />);
    await fireEvent.press(await ask());

    expect(screen.getByText(/doesn’t cancel your booking or refund anything by itself/)).toBeOnTheScreen();
    expect(accountApi.cancellationApi.request).not.toHaveBeenCalled(); // opening the form sends nothing
  });

  it('offers one for a paid package booking as well', async () => {
    resetNavigation({ ref: 'JPP000045' }, { pathname: '/booking/JPP000045', segments: ['booking', '[ref]'] });
    pkg.get.mockResolvedValue(packageBooking({ status: 'confirmed', payments: [payment('captured')] }));
    await renderWithClient(<BookingScreen />);
    expect(await ask()).toBeOnTheScreen();
  });

  it('sends the booking reference and the reason, then shows the reference it was given', async () => {
    hotel.get.mockResolvedValue(paidBooking);
    accountApi.cancellationApi.request.mockResolvedValue({ ...REQUEST, reason: 'Change of plans' });
    await renderWithClient(<BookingScreen />);
    await fireEvent.press(await ask());
    await fireEvent.changeText(screen.getByLabelText('Reason (optional)'), '  Change of plans ');
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));

    expect(await screen.findByText(/We’ve received your cancellation request \(CXL-20261021-000007\)/)).toBeOnTheScreen();
    expect(screen.getByText(/It doesn’t cancel the booking by itself/)).toBeOnTheScreen();
    expect(accountApi.cancellationApi.request).toHaveBeenCalledWith({ booking_ref: 'JPH000123', reason: 'Change of plans' });
    expect(screen.queryByRole('button', { name: 'Ask us to cancel this booking' })).toBeNull(); // not offered a second time
  });

  it('sends no reason at all when none is given', async () => {
    hotel.get.mockResolvedValue(paidBooking);
    accountApi.cancellationApi.request.mockResolvedValue(REQUEST);
    await renderWithClient(<BookingScreen />);
    await fireEvent.press(await ask());
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(accountApi.cancellationApi.request).toHaveBeenCalledWith({ booking_ref: 'JPH000123', reason: null }));
  });

  it('sends one request however often Send is pressed while it is out', async () => {
    hotel.get.mockResolvedValue(paidBooking);
    const gate = deferred<typeof REQUEST>();
    accountApi.cancellationApi.request.mockImplementation(() => gate.promise);
    await renderWithClient(<BookingScreen />);
    await fireEvent.press(await ask());
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(accountApi.cancellationApi.request).toHaveBeenCalledTimes(1));

    gate.resolve(REQUEST);
    expect(await screen.findByText(/We’ve received your cancellation request/)).toBeOnTheScreen();
    expect(accountApi.cancellationApi.request).toHaveBeenCalledTimes(1);
  });

  it('answers “you already asked” as reassurance, not as an error', async () => {
    hotel.get.mockResolvedValue(paidBooking);
    accountApi.cancellationApi.request.mockRejectedValue(
      new ApiError('validation', { status: 400, message: 'A cancellation request is already open for this booking.' }),
    );
    await renderWithClient(<BookingScreen />);
    await fireEvent.press(await ask());
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));

    expect(await screen.findByText('You’ve already asked us to cancel this booking. Our team will be in touch.')).toBeOnTheScreen();
    expect(screen.queryByText(/already open for this booking/)).toBeNull();
  });

  it('shows the server’s sentence for any other refusal, and leaves the form open to try again', async () => {
    hotel.get.mockResolvedValue(paidBooking);
    accountApi.cancellationApi.request.mockRejectedValue(
      new ApiError('validation', { status: 400, message: 'This booking is already cancelled or completed.' }),
    );
    await renderWithClient(<BookingScreen />);
    await fireEvent.press(await ask());
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));

    expect(await screen.findByText('This booking is already cancelled or completed.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Send request' })).toBeOnTheScreen();
  });

  it('can be backed out of', async () => {
    hotel.get.mockResolvedValue(paidBooking);
    await renderWithClient(<BookingScreen />);
    await fireEvent.press(await ask());
    await fireEvent.press(screen.getByRole('button', { name: 'Not now' }));
    expect(await ask()).toBeOnTheScreen();
    expect(accountApi.cancellationApi.request).not.toHaveBeenCalled();
  });

  it.each([
    ['cancelled', hotelBooking({ status: 'cancelled', payments: [] })],
    ['completed', hotelBooking({ status: 'completed', payments: [payment('captured')] })],
    ['refunded', hotelBooking({ status: 'confirmed', payments: [payment('refunded')] })],
    ['mid-payment', hotelBooking({ payments: [payment('pending')] })],
  ])('does not offer a cancellation request for a booking that is %s', async (_label, booking) => {
    hotel.get.mockResolvedValue(booking);
    await renderWithClient(<BookingScreen />);
    await screen.findByRole('button', { name: 'Get help with this booking' });
    expect(screen.queryByRole('button', { name: 'Ask us to cancel this booking' })).toBeNull();
  });
});
