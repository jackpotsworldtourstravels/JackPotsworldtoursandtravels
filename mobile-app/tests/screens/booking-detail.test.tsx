import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';

import { hotelApi, packageApi, paymentsApi } from '@/api/endpoints/booking';
import { ApiError } from '@/api/errors';
import BookingScreen from '@/app/booking/[ref]';

import { checkout, hotelBooking, packageBooking, payment, reconcile } from '../fixtures/booking';
import { deferred, renderWithClient, resetNavigation, router, signOut } from '../helpers/mocks';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('@/api/endpoints/booking', () => ({
  hotelApi: { get: jest.fn(), checkout: jest.fn(), reconcile: jest.fn(), cancel: jest.fn() },
  packageApi: { get: jest.fn(), checkout: jest.fn(), reconcile: jest.fn(), cancel: jest.fn() },
  paymentsApi: { config: jest.fn() },
}));
// Same behaviour, but waiting between reconcile checks costs nothing in a test.
jest.mock('@/features/booking/payment', () => {
  const actual = jest.requireActual('@/features/booking/payment');
  return { ...actual, liveDeps: (open: never) => ({ ...actual.liveDeps(open), sleep: async () => undefined }) };
});

const hotel = hotelApi as jest.Mocked<typeof hotelApi>;
const pkg = packageApi as jest.Mocked<typeof packageApi>;
const payments = paymentsApi as jest.Mocked<typeof paymentsApi>;
const openBrowser = WebBrowser.openBrowserAsync as jest.Mock;

const PAID = reconcile({ booking_status: 'confirmed', payment_status: 'captured', captured: true, code: 'captured', retryable: false });
const paidBooking = hotelBooking({ status: 'confirmed', payments: [payment('captured')] });

beforeEach(() => {
  [hotel, pkg].forEach((api) => Object.values(api).forEach((fn) => (fn as jest.Mock).mockReset()));
  payments.config.mockReset().mockResolvedValue({ configured: true, provider: 'hdfc', key_id: 'SG6226', currency: 'INR', mode: 'real' });
  openBrowser.mockReset().mockResolvedValue({ type: 'dismiss' });
  hotel.get.mockResolvedValue(hotelBooking());
  hotel.checkout.mockResolvedValue(checkout);
  hotel.reconcile.mockResolvedValue(PAID);
  resetNavigation({ ref: 'JPH000123' });
});

const payButton = (total = '₹42,000') => screen.getByRole('button', { name: `Pay ${total}` });

describe('an unpaid booking', () => {
  it('shows the booking, its final price and who is going', async () => {
    await renderWithClient(<BookingScreen />);

    expect(await screen.findByText('Taj Palace')).toBeOnTheScreen();
    expect(screen.getByText('Superior Room · Room only')).toBeOnTheScreen();
    expect(screen.getByText('Booking total')).toBeOnTheScreen();
    expect(screen.getByText('Final price')).toBeOnTheScreen();
    expect(screen.getByText('Taxes & service')).toBeOnTheScreen();
    expect(screen.getByText('₹37,500')).toBeOnTheScreen();
    expect(screen.getAllByText('₹42,000').length).toBeGreaterThan(0);
    expect(screen.getByText('Awaiting payment')).toBeOnTheScreen();
    expect(screen.getByText(/Ravi Rao/)).toBeOnTheScreen();
    expect(payButton()).toBeOnTheScreen();
  });

  it('shows a discount line without doing any arithmetic on it', async () => {
    hotel.get.mockResolvedValue(hotelBooking({ discount: '4200.00', total_amount: '37800.00', coupon_code: 'STAYMORE' }));
    await renderWithClient(<BookingScreen />);
    expect(await screen.findByText('Discount (STAYMORE)')).toBeOnTheScreen();
    expect(screen.getByText('−₹4,200')).toBeOnTheScreen();
    expect(payButton('₹37,800')).toBeOnTheScreen();
  });

  it('warns when the booking total differs from the quote the customer saw, before they pay', async () => {
    hotel.get.mockResolvedValue(hotelBooking({ total_amount: '43000.00' }));
    resetNavigation({ ref: 'JPH000123', quoted: '42000.00' });
    await renderWithClient(<BookingScreen />);

    expect(await screen.findByText(/The price changed between your quote and your booking/)).toBeOnTheScreen();
    expect(screen.getByText(/you were shown ₹42,000, and the booking total is ₹43,000/)).toBeOnTheScreen();
    expect(payButton('₹43,000')).toBeOnTheScreen(); // what is charged is the booking's, never the route's
  });

  it('says nothing when the quote and the booking agree, however the decimals are written', async () => {
    resetNavigation({ ref: 'JPH000123', quoted: '42000' });
    await renderWithClient(<BookingScreen />);
    await screen.findByText('Taj Palace');
    expect(screen.queryByText(/The price changed/)).toBeNull();
  });

  it('ignores a rubbish `quoted` parameter instead of acting on it', async () => {
    resetNavigation({ ref: 'JPH000123', quoted: '<script>' });
    await renderWithClient(<BookingScreen />);
    await screen.findByText('Taj Palace');
    expect(screen.queryByText(/The price changed/)).toBeNull();
  });
});

describe('paying', () => {
  it('opens a checkout with the stable key, shows the hosted page, then trusts only the backend’s verdict', async () => {
    hotel.get.mockReset().mockResolvedValueOnce(hotelBooking()).mockResolvedValue(paidBooking);
    await renderWithClient(<BookingScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Pay ₹42,000' }));

    await waitFor(() => expect(hotel.checkout).toHaveBeenCalledWith('JPH000123', 'pay-JPH000123-1'));
    expect(payments.config).toHaveBeenCalledWith('JPH000123');
    expect(openBrowser).toHaveBeenCalledWith(checkout.redirect_url, expect.anything());
    await waitFor(() => expect(hotel.reconcile).toHaveBeenCalled());

    expect(await screen.findByText('Payment received. This booking is confirmed.')).toBeOnTheScreen();
    expect(screen.queryByText('Payment received. Your booking is confirmed.')).toBeNull(); // said once, not twice
    expect(screen.getByText('Confirmed')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel booking' })).toBeNull();
  });

  it('does NOT say paid when the customer closes the page but the backend still sees nothing', async () => {
    hotel.reconcile.mockResolvedValue(reconcile()); // pending, retryable
    await renderWithClient(<BookingScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Pay ₹42,000' }));

    expect(await screen.findByText(/We haven’t heard back from the bank yet/)).toBeOnTheScreen();
    expect(screen.queryByText(/Payment received/)).toBeNull();
    expect(screen.queryByText('Confirmed')).toBeNull();
    expect(screen.getByRole('button', { name: /^Pay / })).toBeOnTheScreen(); // still payable, not falsely done
  });

  it('does NOT say confirmed when money arrived but the booking was not confirmed', async () => {
    hotel.reconcile.mockResolvedValue(reconcile({ payment_status: 'captured', booking_status: 'pending', captured: true }));
    hotel.get.mockReset().mockResolvedValueOnce(hotelBooking()).mockResolvedValue(hotelBooking({ status: 'pending', payments: [payment('captured')] }));
    await renderWithClient(<BookingScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Pay ₹42,000' }));

    expect(await screen.findAllByText(/received your payment, but (your|this) booking isn’t confirmed yet/)).toHaveLength(1);
    expect(screen.queryByText('Confirmed')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull(); // never invites a second payment
    expect(screen.getByText('Payment under review')).toBeOnTheScreen();
  });

  it('reports a failed payment plainly and offers another go with a NEW key', async () => {
    hotel.reconcile.mockResolvedValue(reconcile({ payment_status: 'failed', retryable: false }));
    hotel.get.mockReset().mockResolvedValueOnce(hotelBooking()).mockResolvedValue(hotelBooking({ payments: [payment('failed')] }));
    await renderWithClient(<BookingScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Pay ₹42,000' }));
    expect((await screen.findAllByText(/haven’t been charged/)).length).toBeGreaterThan(0);

    await fireEvent.press(await screen.findByRole('button', { name: 'Pay ₹42,000' }));
    await waitFor(() => expect(hotel.checkout).toHaveBeenCalledTimes(2));
    expect(hotel.checkout.mock.calls[1][1]).toBe('pay-JPH000123-2');
  });

  it('opens one checkout, however many times Pay is pressed while it is working', async () => {
    const gate = deferred<typeof checkout>();
    hotel.checkout.mockReset().mockImplementation(() => gate.promise);
    await renderWithClient(<BookingScreen />);

    await fireEvent.press(await screen.findByRole('button', { name: 'Pay ₹42,000' }));
    await waitFor(() => expect(hotel.checkout).toHaveBeenCalledTimes(1));
    await fireEvent.press(screen.getByRole('button', { name: 'Pay ₹42,000' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Pay ₹42,000' }));
    gate.resolve(checkout);

    await waitFor(() => expect(hotel.reconcile).toHaveBeenCalled());
    expect(hotel.checkout).toHaveBeenCalledTimes(1);
    expect(openBrowser).toHaveBeenCalledTimes(1);
  });

  it('shows the server’s own sentence when it refuses, and opens no browser', async () => {
    hotel.checkout.mockReset().mockRejectedValue(
      new ApiError('validation', { status: 400, message: 'JPH000123 was held for 30 minutes and that time has passed, so it can no longer be paid for.' }),
    );
    await renderWithClient(<BookingScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Pay ₹42,000' }));

    expect(await screen.findByText(/held for 30 minutes and that time has passed/)).toBeOnTheScreen();
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it('says so, and opens nothing, when online payment is not configured', async () => {
    payments.config.mockResolvedValue({ configured: false, provider: null, key_id: null, currency: 'INR', mode: 'real' });
    await renderWithClient(<BookingScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Pay ₹42,000' }));

    expect(await screen.findByText(/Online payment isn’t available right now/)).toBeOnTheScreen();
    expect(hotel.checkout).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it('refuses a server in demo payment mode instead of showing a payment that cannot finish', async () => {
    payments.config.mockResolvedValue({ configured: true, provider: 'mock', key_id: 'k', currency: 'INR', mode: 'demo' });
    await renderWithClient(<BookingScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Pay ₹42,000' }));
    expect(await screen.findByText(/demo payment mode/)).toBeOnTheScreen();
    expect(hotel.checkout).not.toHaveBeenCalled();
  });

  it('is honest when the provider has no hosted page the app can open', async () => {
    hotel.checkout.mockResolvedValue({ ...checkout, redirect_url: null });
    await renderWithClient(<BookingScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Pay ₹42,000' }));
    expect(await screen.findByText(/can’t be completed inside the app yet/)).toBeOnTheScreen();
    expect(openBrowser).not.toHaveBeenCalled();
    expect(hotel.reconcile).not.toHaveBeenCalled();
  });

  it('keeps saying so after the booking is re-read with the order it just opened, and does not start a quiet bank check of its own', async () => {
    // As on a real server: starting a checkout opens an order, so the next read shows a pending payment.
    hotel.get.mockResolvedValueOnce(hotelBooking()).mockResolvedValue(hotelBooking({ payments: [payment('pending')] }));
    hotel.checkout.mockResolvedValue({ ...checkout, redirect_url: null });
    await renderWithClient(<BookingScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Pay ₹42,000' }));

    expect(await screen.findByRole('button', { name: 'Continue to payment' })).toBeOnTheScreen(); // re-read happened
    expect(screen.getByText(/can’t be completed inside the app yet/)).toBeOnTheScreen();
    expect(screen.queryByText(/Confirming with the bank/)).toBeNull();
    expect(hotel.reconcile).not.toHaveBeenCalled();
  });

  it('pays for a package booking through the package endpoints', async () => {
    resetNavigation({ ref: 'JPP000045' });
    pkg.get.mockResolvedValue(packageBooking());
    pkg.checkout.mockResolvedValue({ ...checkout, booking_ref: 'JPP000045' });
    pkg.reconcile.mockResolvedValue(reconcile({ booking_ref: 'JPP000045', booking_status: 'confirmed', payment_status: 'captured', captured: true }));
    await renderWithClient(<BookingScreen />);

    expect(await screen.findByText('Departs', { exact: false })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Pay ₹64,890' }));
    await waitFor(() => expect(pkg.checkout).toHaveBeenCalledWith('JPP000045', 'pay-JPP000045-1'));
    expect(hotel.checkout).not.toHaveBeenCalled();
  });
});

describe('coming back to a payment', () => {
  it('quietly asks the backend about a payment that was left open, without any button press', async () => {
    hotel.get.mockResolvedValue(hotelBooking({ payments: [payment('pending')] }));
    await renderWithClient(<BookingScreen />);

    await waitFor(() => expect(hotel.reconcile).toHaveBeenCalledTimes(1));
    expect(hotel.checkout).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it('resumes the open order with the same key, offers a manual check, and never offers to cancel mid-payment', async () => {
    hotel.get.mockResolvedValue(hotelBooking({ payments: [payment('pending')] }));
    hotel.reconcile.mockResolvedValue(reconcile()); // still waiting
    await renderWithClient(<BookingScreen />);

    expect(await screen.findByText('Payment in progress')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Continue to payment' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Check payment status' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Cancel booking' })).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'Continue to payment' }));
    await waitFor(() => expect(hotel.checkout).toHaveBeenCalledWith('JPH000123', 'pay-JPH000123-1'));
  });

  it('shows a settled booking as settled: no Pay, no Cancel', async () => {
    hotel.get.mockResolvedValue(paidBooking);
    await renderWithClient(<BookingScreen />);
    expect(await screen.findByText('Payment received. This booking is confirmed.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel booking' })).toBeNull();
    expect(hotel.reconcile).not.toHaveBeenCalled();
  });
});

describe('cancelling an unpaid booking', () => {
  it('asks first, then cancels, and shows the booking as cancelled', async () => {
    hotel.cancel.mockResolvedValue(hotelBooking({ status: 'cancelled' }));
    hotel.get.mockReset().mockResolvedValueOnce(hotelBooking()).mockResolvedValue(hotelBooking({ status: 'cancelled' }));
    await renderWithClient(<BookingScreen />);

    await fireEvent.press(await screen.findByRole('button', { name: 'Cancel booking' }));
    expect(hotel.cancel).not.toHaveBeenCalled(); // one tap is only a question
    expect(screen.getByText(/It hasn’t been paid for, so nothing will be charged/)).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Yes, cancel booking' }));
    await waitFor(() => expect(hotel.cancel).toHaveBeenCalledWith('JPH000123'));
    expect(await screen.findByText('This booking was cancelled.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull();
  });

  it('can be backed out of', async () => {
    await renderWithClient(<BookingScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Cancel booking' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Keep booking' }));
    expect(hotel.cancel).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel booking' })).toBeOnTheScreen();
  });

  it('is not offered once money has arrived: that is for the desk', async () => {
    hotel.get.mockResolvedValue(hotelBooking({ status: 'pending', payments: [payment('captured')] }));
    await renderWithClient(<BookingScreen />);
    await screen.findByText('Payment under review');
    expect(screen.queryByRole('button', { name: 'Cancel booking' })).toBeNull();
  });
});

describe('who may see a booking', () => {
  it('asks a signed-out visitor to sign in and fetches nothing', async () => {
    signOut();
    await renderWithClient(<BookingScreen />);
    expect(await screen.findByText('Sign in to see this booking')).toBeOnTheScreen();
    expect(hotel.get).not.toHaveBeenCalled();
  });

  it('says "not on this account" for someone else’s reference, which the backend answers with a 404', async () => {
    hotel.get.mockReset().mockRejectedValue(new ApiError('not_found', { status: 404 }));
    await renderWithClient(<BookingScreen />);
    expect(await screen.findByText('We couldn’t find that booking')).toBeOnTheScreen();
    expect(screen.getByText('It isn’t on this account.')).toBeOnTheScreen();
  });

  it('refuses a malformed reference without a request', async () => {
    resetNavigation({ ref: 'JPH000123/../../x' });
    await renderWithClient(<BookingScreen />);
    expect(await screen.findByText('That isn’t a booking reference')).toBeOnTheScreen();
    expect(hotel.get).not.toHaveBeenCalled();
  });

  it('does not pretend to manage a flight booking', async () => {
    resetNavigation({ ref: 'JPB000027' });
    await renderWithClient(<BookingScreen />);
    expect(await screen.findByText('Flight bookings aren’t available in the app')).toBeOnTheScreen();
    expect(hotel.get).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('offers a retry on a network failure', async () => {
    hotel.get.mockReset().mockRejectedValueOnce(new ApiError('network')).mockResolvedValue(hotelBooking());
    await renderWithClient(<BookingScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Taj Palace')).toBeOnTheScreen();
  });
});
