import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { packageApi } from '@/api/endpoints/booking';
import { ApiError } from '@/api/errors';
import BookPackageScreen from '@/app/book/package';
import { returnTo, routeKey } from '@/features/auth/returnTo';
import { _resetAttemptMemoryForTests } from '@/features/booking/attempts';
import { emptyPackageForm } from '@/features/booking/packageRequest';
import { addDays, todayISO } from '@/utils/dates';

import { IN_30, internationalPackage, packageBooking, packageDetail, packageQuote } from '../fixtures/booking';
import { renderWithClient, resetNavigation, router, signInAsGuest, signOut } from '../helpers/mocks';
import { resetAccountApi } from '../helpers/accountMock';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);
jest.mock('@/api/endpoints/account', () => require('../helpers/accountMock').accountApiModule);
jest.mock('@/api/endpoints/booking', () => ({ packageApi: { detail: jest.fn(), quote: jest.fn(), create: jest.fn() } }));

const api = packageApi as jest.Mocked<typeof packageApi>;
const store = () => (globalThis as { __secureStoreForTests?: Map<string, string> }).__secureStoreForTests!;
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
  api.detail.mockReset().mockResolvedValue(packageDetail());
  api.quote.mockReset().mockResolvedValue(packageQuote);
  api.create.mockReset().mockResolvedValue(packageBooking());
  returnTo.clear();
  resetNavigation({ packageId: '7', departureId: '55', pax: '2' }, { pathname: '/book/package', segments: ['book', 'package'] });
});

const confirm = () => screen.getByRole('button', { name: 'Confirm booking' });

async function openReady() {
  const rendered = await renderWithClient(<BookPackageScreen />);
  await screen.findByText('Priced by our server');
  return rendered;
}

async function fillSecondTraveller() {
  await fireEvent.changeText(screen.getAllByLabelText('First name')[1], 'Ravi');
  await fireEvent.changeText(screen.getAllByLabelText('Last name')[1], 'Rao');
}

describe('package review', () => {
  it('shows the trip and the server’s quote, with GST, under its own heading', async () => {
    await openReady();
    expect(screen.getByText('Your trip')).toBeOnTheScreen();
    expect(screen.getByText('Package × 2')).toBeOnTheScreen();
    expect(screen.getByText('GST')).toBeOnTheScreen();
    expect(screen.getByText('₹64,890')).toBeOnTheScreen();
    expect(api.quote).toHaveBeenCalledWith({ trip: { package_id: 7, departure_id: 55, pax_count: 2 }, addons: [], coupon_code: null });
  });

  it.each([
    ['a departure that has already left', { departureId: '49' }],
    ['a sold-out departure', { departureId: '56' }],
    ['an unknown departure', { departureId: '12345' }],
    ['more travellers than seats left', { pax: '5' }],
    ['no travellers', { pax: '0' }],
    ['a non-numeric package', { packageId: 'abc' }],
    ['a fractional traveller count', { pax: '1.5' }],
  ])('refuses %s and never prices it', async (_name, patch) => {
    resetNavigation({ packageId: '7', departureId: '55', pax: '2', ...patch });
    api.quote.mockClear();
    await renderWithClient(<BookPackageScreen />);
    expect(await screen.findByText('These booking details aren’t valid')).toBeOnTheScreen();
    expect(api.quote).not.toHaveBeenCalled();
  });
});

describe('domestic booking', () => {
  it('creates one pending booking with a key, the trip and the travellers, and no money', async () => {
    await openReady();
    await fillSecondTraveller();
    await fireEvent.press(confirm());

    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    const body = api.create.mock.calls[0][0];
    expect(body.trip).toEqual({ package_id: 7, departure_id: 55, pax_count: 2 });
    expect(body.idempotency_key.length).toBeGreaterThanOrEqual(8);
    expect(body.travellers.map((t) => [t.first_name, t.is_contact])).toEqual([['Asha', true], ['Ravi', false]]);
    expect(body.travellers[0]).not.toHaveProperty('passport_number');
    expect(keysOf(body).filter((k) => MONEY_KEY.test(k))).toEqual([]);

    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith({ pathname: '/booking/[ref]', params: { ref: 'JPP000045', quoted: '64890.00' } }),
    );
  });

  it('retries with the SAME key after a timeout, and the key is gone once the booking exists', async () => {
    api.create.mockReset().mockRejectedValueOnce(new ApiError('timeout')).mockResolvedValueOnce(packageBooking());
    await openReady();
    await fillSecondTraveller();

    await fireEvent.press(confirm());
    expect(await screen.findByText(/it won’t create a second one/)).toBeOnTheScreen();
    await fireEvent.press(confirm());

    await waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
    expect(api.create.mock.calls[1][0].idempotency_key).toBe(api.create.mock.calls[0][0].idempotency_key);
    expect(JSON.parse(store().get('jp.booking_attempts') ?? '[]')).toEqual([]);
  });

  it('shows the server’s sentence when seats ran out between review and booking', async () => {
    api.create.mockReset().mockRejectedValue(new ApiError('validation', { status: 400, message: 'Only 1 seats are left on this departure.' }));
    await openReady();
    await fillSecondTraveller();
    await fireEvent.press(confirm());
    expect(await screen.findByText('Only 1 seats are left on this departure.')).toBeOnTheScreen();
  });

  it('asks a signed-out customer to sign in and creates nothing', async () => {
    signOut();
    await openReady();
    await fireEvent.changeText(screen.getAllByLabelText('First name')[0], 'Asha');
    await fireEvent.changeText(screen.getAllByLabelText('Last name')[0], 'Rao');
    await fireEvent.changeText(screen.getByLabelText('Email'), 'asha@example.com');
    await fireEvent.changeText(screen.getByLabelText('Mobile number'), '+919876543210');
    await fillSecondTraveller();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in to book' }));

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/sign-in'));
    expect(api.create).not.toHaveBeenCalled();

    // The way back and the form are kept for the root to restore after sign-in.
    expect(returnTo.isPending()).toBe(true);
    const saved = returnTo.draftFor('package', routeKey('/book/package', { packageId: '7', departureId: '55', pax: '2' }));
    expect(saved?.values).toMatchObject({
      travellers: [{ first_name: 'Asha', last_name: 'Rao' }, { first_name: 'Ravi', last_name: 'Rao' }],
      email: 'asha@example.com',
    });
  });

  it('comes back from sign-in with the travellers already filled in, then forgets them', async () => {
    const route = routeKey('/book/package', { packageId: '7', departureId: '55', pax: '2' });
    const empty = emptyPackageForm(2, { firstName: '', lastName: '', email: '', mobile: '' });
    returnTo.set(
      { at: '/book/package', href: '/book/package' as never },
      {
        kind: 'package',
        route,
        coupon: undefined,
        values: {
          ...empty,
          email: 'asha@example.com',
          mobile: '+919876543210',
          travellers: empty.travellers.map((t, i) => ({ ...t, first_name: ['Asha', 'Ravi'][i], last_name: 'Rao' })),
        },
      },
    );
    signInAsGuest();
    await renderWithClient(<BookPackageScreen />);
    await screen.findByText('Priced by our server');

    expect(screen.getAllByLabelText('First name').map((f) => f.props.value)).toEqual(['Asha', 'Ravi']);
    expect(screen.getByLabelText('Email').props.value).toBe('asha@example.com');
    expect(returnTo.draftFor('package', route)).toBeNull();
  });

  it('needs a name for every traveller', async () => {
    await openReady();
    await fireEvent.press(confirm());
    expect(await screen.findAllByText('First name is required.')).toHaveLength(1);
    expect(api.create).not.toHaveBeenCalled();
  });
});

describe('international booking', () => {
  const departureAhead = addDays(todayISO(), 30);

  beforeEach(() => {
    api.detail.mockResolvedValue(internationalPackage);
    resetNavigation({ packageId: '12', departureId: '80', pax: '2' });
  });

  it('explains the passport rule up front', async () => {
    await openReady();
    expect(screen.getByText(/passport valid for at least 6 months after the departure date/)).toBeOnTheScreen();
    expect(screen.getAllByLabelText('Passport number')).toHaveLength(2);
  });

  it('will not book without passport details, and says what is missing', async () => {
    await openReady();
    await fillSecondTraveller();
    await fireEvent.press(confirm());

    expect((await screen.findAllByText('Passport number is required for this destination.')).length).toBeGreaterThan(0);
    expect(api.create).not.toHaveBeenCalled();
  });

  it('refuses a passport that expires less than six months after departure', async () => {
    await openReady();
    await fillSecondTraveller();
    const shortExpiry = addDays(departureAhead, 150); // about five months
    for (const box of screen.getAllByLabelText('Passport number')) await fireEvent.changeText(box, 'N1234567');
    for (const box of screen.getAllByLabelText('Passport expiry (YYYY-MM-DD)')) await fireEvent.changeText(box, shortExpiry);
    await fireEvent.press(confirm());

    expect((await screen.findAllByText('The passport must be valid for at least 6 months after the departure date.')).length).toBeGreaterThan(0);
    expect(api.create).not.toHaveBeenCalled();
  });

  it('books with passports once they are valid, sending them only because the trip is international', async () => {
    await openReady();
    await fillSecondTraveller();
    const goodExpiry = addDays(departureAhead, 400);
    for (const box of screen.getAllByLabelText('Passport number')) await fireEvent.changeText(box, 'N1234567');
    for (const box of screen.getAllByLabelText('Passport expiry (YYYY-MM-DD)')) await fireEvent.changeText(box, goodExpiry);
    await fireEvent.press(confirm());

    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    const body = api.create.mock.calls[0][0];
    expect(body.travellers[0]).toMatchObject({ passport_number: 'N1234567', passport_expiry: goodExpiry, is_contact: true });
    expect(body.travellers[1]).toMatchObject({ passport_number: 'N1234567', passport_expiry: goodExpiry, is_contact: false });
    expect(IN_30).toBeTruthy();
  });
});
