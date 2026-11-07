import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { hotelApi } from '@/api/endpoints/booking';
import { ApiError } from '@/api/errors';
import BookHotelScreen from '@/app/book/hotel';
import { returnTo, routeKey } from '@/features/auth/returnTo';
import { _resetAttemptMemoryForTests } from '@/features/booking/attempts';

import { IN_30, IN_33, badCouponQuote, hotelBooking, hotelDetail, hotelQuote, hotelQuoteWithCoupon, LAST_MONTH } from '../fixtures/booking';
import { deferred, renderWithClient, resetNavigation, router, signInAsGuest, signOut } from '../helpers/mocks';
import { resetAccountApi } from '../helpers/accountMock';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);
jest.mock('@/api/endpoints/account', () => require('../helpers/accountMock').accountApiModule);
jest.mock('@/api/endpoints/booking', () => ({ hotelApi: { detail: jest.fn(), quote: jest.fn(), create: jest.fn() } }));

const api = hotelApi as jest.Mocked<typeof hotelApi>;
const store = () => (globalThis as { __secureStoreForTests?: Map<string, string> }).__secureStoreForTests!;

const PARAMS = { hotelId: '1', roomId: '1', checkIn: IN_30, checkOut: IN_33, rooms: '1', adults: '2', children: '0' };
const MONEY_KEY = /price|amount|total|tax|currency|fare|cost|fee|discount|subtotal/i;

function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysOf(v, out);
    }
  }
  return out;
}

beforeEach(() => {
  resetAccountApi();
  _resetAttemptMemoryForTests();
  store().clear();
  api.detail.mockReset().mockResolvedValue(hotelDetail);
  api.create.mockReset().mockResolvedValue(hotelBooking());
  api.quote.mockReset().mockImplementation(async (req) =>
    req.coupon_code === 'STAYMORE' ? hotelQuoteWithCoupon : req.coupon_code === 'BADCODE' ? badCouponQuote : hotelQuote,
  );
  returnTo.clear();
  resetNavigation(PARAMS);
});

const confirmButton = (label = 'Confirm booking') => screen.getByRole('button', { name: label });

/** The signed-in customer is pre-filled as guest 1; this completes guest 2. */
async function fillSecondGuest(first = 'Ravi', last = 'Rao') {
  await fireEvent.changeText(screen.getAllByLabelText('First name')[1], first);
  await fireEvent.changeText(screen.getAllByLabelText('Last name')[1], last);
}

async function openReady() {
  const rendered = await renderWithClient(<BookHotelScreen />);
  await screen.findByText('Priced by our server');
  return rendered;
}

describe('the quote', () => {
  it('shows the server’s itemised price under its own heading, separate from any indicative rate', async () => {
    await openReady();

    expect(screen.getByText('Your quote')).toBeOnTheScreen();
    expect(screen.getByText('Superior Room × 3 nights')).toBeOnTheScreen();
    expect(screen.getByText('Taxes & service')).toBeOnTheScreen();
    expect(screen.getByText('Total to pay')).toBeOnTheScreen();
    expect(screen.getByText('₹42,000')).toBeOnTheScreen();
    expect(screen.queryByText('Indicative rate')).toBeNull();
  });

  it('asks the server to price exactly the chosen room, dates and party, with no money in the request', async () => {
    await openReady();
    const request = api.quote.mock.calls[0][0];
    expect(request).toEqual({
      stay: { hotel_id: 1, room_id: 1, check_in: IN_30, check_out: IN_33, rooms_count: 1, adults: 2, children: 0 },
      addons: [],
      coupon_code: null,
    });
    expect(keysOf(request).filter((k) => MONEY_KEY.test(k))).toEqual([]);
  });

  it('applies a coupon through the server and shows the discount line and new total', async () => {
    await openReady();
    await fireEvent.changeText(screen.getByLabelText('Coupon code (optional)'), 'staymore');
    await fireEvent.press(screen.getByRole('button', { name: 'Apply code' }));

    expect(await screen.findByText('Discount (STAYMORE)')).toBeOnTheScreen();
    expect(screen.getByText('−₹4,200')).toBeOnTheScreen();
    expect(screen.getByText('₹37,800')).toBeOnTheScreen();
    expect(api.quote.mock.calls.at(-1)?.[0].coupon_code).toBe('STAYMORE');
  });

  it('blocks booking while a coupon is rejected, shows the reason, and unblocks when it is removed', async () => {
    await openReady();
    await fireEvent.changeText(screen.getByLabelText('Coupon code (optional)'), 'badcode');
    await fireEvent.press(screen.getByRole('button', { name: 'Apply code' }));

    expect(await screen.findByText('That coupon code is not valid.')).toBeOnTheScreen();
    expect(confirmButton()).toBeDisabled();

    await fireEvent.press(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(confirmButton()).toBeEnabled());
  });

  it('will not let anyone book against a quote that is still updating', async () => {
    await openReady();
    const slow = deferred<typeof hotelQuoteWithCoupon>();
    api.quote.mockImplementationOnce(() => slow.promise);

    await fireEvent.changeText(screen.getByLabelText('Coupon code (optional)'), 'staymore');
    await fireEvent.press(screen.getByRole('button', { name: 'Apply code' }));

    expect(await screen.findByText('Updating…')).toBeOnTheScreen();
    expect(confirmButton()).toBeDisabled();

    slow.resolve(hotelQuoteWithCoupon);
    await waitFor(() => expect(confirmButton()).toBeEnabled());
  });

  it('shows a retry when the stay cannot be priced', async () => {
    api.quote.mockReset().mockRejectedValueOnce(new ApiError('validation', { status: 400, message: 'Only 1 Superior Room can be booked at once.' }));
    await renderWithClient(<BookHotelScreen />);
    expect(await screen.findByText('Couldn’t price your stay')).toBeOnTheScreen();
    expect(screen.getByText('Only 1 Superior Room can be booked at once.')).toBeOnTheScreen();
  });
});

describe('route safety', () => {
  it('refuses dates in the past, and asks the network for nothing', async () => {
    resetNavigation({ ...PARAMS, checkIn: LAST_MONTH, checkOut: IN_30 });
    api.quote.mockClear();
    api.detail.mockClear();
    await renderWithClient(<BookHotelScreen />);
    expect(await screen.findByText('These booking details aren’t valid')).toBeOnTheScreen();
    expect(api.quote).not.toHaveBeenCalled();
    expect(api.detail).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-numeric hotel', { hotelId: 'abc' }],
    ['a missing room', { roomId: '' }],
    ['check-out before check-in', { checkIn: IN_33, checkOut: IN_30 }],
  ])('refuses %s', async (_name, patch) => {
    resetNavigation({ ...PARAMS, ...patch });
    await renderWithClient(<BookHotelScreen />);
    expect(await screen.findByText('These booking details aren’t valid')).toBeOnTheScreen();
  });

  it('says so when the room is not at that hotel', async () => {
    resetNavigation({ ...PARAMS, roomId: '999' });
    await renderWithClient(<BookHotelScreen />);
    expect(await screen.findByText('That room isn’t available')).toBeOnTheScreen();
    expect(api.quote).not.toHaveBeenCalled();
  });
});

describe('creating the booking', () => {
  it('validates the guests first and creates nothing until the form is right', async () => {
    await openReady();
    await fireEvent.press(confirmButton());
    expect(await screen.findAllByText('First name is required.')).toHaveLength(1);
    expect(api.create).not.toHaveBeenCalled();
  });

  it('creates ONE pending booking with an idempotency key and no money, then goes to its page', async () => {
    await openReady();
    await fillSecondGuest();
    await fireEvent.press(confirmButton());

    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    const body = api.create.mock.calls[0][0];
    expect(body.idempotency_key.length).toBeGreaterThanOrEqual(8);
    expect(body.stay).toMatchObject({ hotel_id: 1, room_id: 1, check_in: IN_30, check_out: IN_33, adults: 2 });
    expect(body.guests.map((g) => [g.first_name, g.is_contact])).toEqual([['Asha', true], ['Ravi', false]]);
    expect(body.guests[0]).toMatchObject({ email: 'asha@example.com', mobile: '+919876543210' });
    expect(keysOf(body).filter((k) => MONEY_KEY.test(k))).toEqual([]);

    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith({ pathname: '/booking/[ref]', params: { ref: 'JPH000123', quoted: '42000.00' } }),
    );
  });

  it('cannot create a second booking by tapping again while the first request is still out', async () => {
    const gate = deferred<ReturnType<typeof hotelBooking>>();
    api.create.mockReset().mockImplementation(() => gate.promise);
    await openReady();
    await fillSecondGuest();

    await fireEvent.press(confirmButton());
    await waitFor(() => expect(api.create).toHaveBeenCalled());
    // Still out: the button is busy and further taps do nothing. (Taps in the same instant, before
    // any re-render, are covered by the useSingleFlight tests.)
    await fireEvent.press(confirmButton());
    await fireEvent.press(confirmButton());
    gate.resolve(hotelBooking());

    await waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it('after a timeout, retries with the SAME key and tells the customer a retry is safe', async () => {
    api.create.mockReset().mockRejectedValueOnce(new ApiError('timeout')).mockResolvedValueOnce(hotelBooking());
    await openReady();
    await fillSecondGuest();

    await fireEvent.press(confirmButton());
    expect(await screen.findByText(/it won’t create a second one/)).toBeOnTheScreen();
    expect(router.replace).not.toHaveBeenCalled();

    await fireEvent.press(confirmButton());
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(2));
    expect(api.create.mock.calls[1][0].idempotency_key).toBe(api.create.mock.calls[0][0].idempotency_key);
    await waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
  });

  it('also keeps the key across an app restart between the attempts', async () => {
    api.create.mockReset().mockRejectedValueOnce(new ApiError('network')).mockResolvedValueOnce(hotelBooking());
    const first = await openReady();
    await fillSecondGuest();
    await fireEvent.press(confirmButton());
    await screen.findByText(/it won’t create a second one/);
    const firstKey = api.create.mock.calls[0][0].idempotency_key;

    await first.result.unmount();
    _resetAttemptMemoryForTests(); // memory gone; only SecureStore survives
    await openReady();
    await fillSecondGuest();
    await fireEvent.press(confirmButton());

    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(2));
    expect(api.create.mock.calls[1][0].idempotency_key).toBe(firstKey);
  });

  it('sends a NEW key once the customer has changed anything, because the server would hand back the old booking for an old key', async () => {
    api.create.mockReset().mockRejectedValueOnce(new ApiError('timeout')).mockResolvedValueOnce(hotelBooking());
    await openReady();
    await fillSecondGuest('Ravi', 'Rao');
    await fireEvent.press(confirmButton());
    await screen.findByText(/it won’t create a second one/);

    await fireEvent.changeText(screen.getAllByLabelText('Last name')[1], 'Rau'); // a correction
    await fireEvent.press(confirmButton());

    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(2));
    expect(api.create.mock.calls[1][0].idempotency_key).not.toBe(api.create.mock.calls[0][0].idempotency_key);
  });

  it('forgets the key once the booking exists, so booking the same trip again on purpose is a new booking', async () => {
    await openReady();
    await fillSecondGuest();
    await fireEvent.press(confirmButton());
    await waitFor(() => expect(router.replace).toHaveBeenCalled());

    expect(JSON.parse(store().get('jp.booking_attempts') ?? '[]')).toEqual([]);
  });

  it('shows the server’s own sentence for a refusal, and does NOT claim the retry is safe', async () => {
    api.create.mockReset().mockRejectedValue(new ApiError('validation', { status: 400, message: 'Only 1 Superior Room can be booked at once.' }));
    await openReady();
    await fillSecondGuest();
    await fireEvent.press(confirmButton());

    expect(await screen.findByText('Only 1 Superior Room can be booked at once.')).toBeOnTheScreen();
    expect(screen.queryByText(/won’t create a second one/)).toBeNull();
  });

  it('asks a signed-out customer to sign in, keeps their form, and creates nothing', async () => {
    signOut();
    await openReady();
    expect(confirmButton('Sign in to book')).toBeOnTheScreen();

    await fireEvent.changeText(screen.getAllByLabelText('First name')[0], 'Asha');
    await fireEvent.changeText(screen.getAllByLabelText('Last name')[0], 'Rao');
    await fireEvent.changeText(screen.getByLabelText('Email'), 'asha@example.com');
    await fireEvent.changeText(screen.getByLabelText('Mobile number'), '+919876543210');
    await fillSecondGuest();
    await fireEvent.press(confirmButton('Sign in to book'));

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/sign-in'));
    expect(api.create).not.toHaveBeenCalled();
  });
});

describe('signing in from the form and coming back', () => {
  const ROUTE = routeKey('/book/hotel', PARAMS);

  it('records where to return and what was typed, so the form survives the screen being torn down', async () => {
    signOut();
    await openReady();
    await fireEvent.changeText(screen.getAllByLabelText('First name')[0], 'Asha');
    await fireEvent.changeText(screen.getAllByLabelText('Last name')[0], 'Rao');
    await fireEvent.changeText(screen.getByLabelText('Email'), 'asha@example.com');
    await fireEvent.changeText(screen.getByLabelText('Mobile number'), '+919876543210');
    await fillSecondGuest();
    await fireEvent.changeText(screen.getByLabelText('Coupon code (optional)'), 'staymore');
    await fireEvent.press(screen.getByRole('button', { name: 'Apply code' }));
    await screen.findByText('Discount (STAYMORE)');
    await fireEvent.press(confirmButton('Sign in to book'));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/sign-in'));

    expect(returnTo.isPending()).toBe(true);
    const saved = returnTo.draftFor('hotel', ROUTE);
    expect(saved?.coupon).toBe('STAYMORE');
    expect(saved?.values).toMatchObject({
      guests: [{ first_name: 'Asha', last_name: 'Rao' }, { first_name: 'Ravi', last_name: 'Rao' }],
      email: 'asha@example.com',
      mobile: '+919876543210',
    });
    expect(returnTo.take()).toEqual({ at: '/book/hotel', tab: false, href: `/book/hotel?${new URLSearchParams(PARAMS).toString().split('&').sort().join('&')}` });
  });

  it('comes back with the names, contact details and coupon already filled in, then forgets them', async () => {
    returnTo.set(
      { at: '/book/hotel', href: '/book/hotel' as never },
      {
        kind: 'hotel',
        route: ROUTE,
        coupon: 'STAYMORE',
        values: {
          guests: [{ first_name: 'Asha', last_name: 'Rao' }, { first_name: 'Ravi', last_name: 'Rao' }],
          email: 'asha@example.com',
          mobile: '+919876543210',
          notes: 'Late arrival',
        },
      },
    );
    signInAsGuest(); // a guest session has no details of its own to pre-fill
    await renderWithClient(<BookHotelScreen />);

    expect(await screen.findByText('Discount (STAYMORE)')).toBeOnTheScreen();
    expect(screen.getAllByLabelText('First name').map((f) => f.props.value)).toEqual(['Asha', 'Ravi']);
    expect(screen.getByLabelText('Email').props.value).toBe('asha@example.com');
    expect(screen.getByLabelText('Notes for the hotel (optional)').props.value).toBe('Late arrival');
    expect(api.quote.mock.calls.at(-1)?.[0].coupon_code).toBe('STAYMORE');
    expect(returnTo.draftFor('hotel', ROUTE)).toBeNull();
  });

  it('never fills a different booking’s form from someone else’s draft', async () => {
    returnTo.set(
      { at: '/book/hotel', href: '/book/hotel' as never },
      { kind: 'hotel', route: routeKey('/book/hotel', { ...PARAMS, roomId: '2' }), coupon: 'STAYMORE', values: { guests: [{ first_name: 'Nobody', last_name: 'Else' }, { first_name: 'X', last_name: 'Y' }], email: 'x@example.com', mobile: '+911111111111', notes: '' } },
    );
    await openReady();
    expect(screen.getAllByLabelText('First name')[0].props.value).toBe('Asha');
    expect(screen.queryByText('Discount (STAYMORE)')).toBeNull();
  });
});
