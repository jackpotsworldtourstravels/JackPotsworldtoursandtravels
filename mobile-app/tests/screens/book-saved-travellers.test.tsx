import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { hotelApi, packageApi } from '@/api/endpoints/booking';
import { ApiError } from '@/api/errors';
import BookHotelScreen from '@/app/book/hotel';
import BookPackageScreen from '@/app/book/package';
import SignInScreen from '@/app/(auth)/sign-in';
import { _resetAttemptMemoryForTests } from '@/features/booking/attempts';
import { addDays, todayISO } from '@/utils/dates';

import { savedTraveller } from '../fixtures/account';
import {
  hotelBooking,
  hotelDetail,
  hotelQuote,
  IN_30,
  IN_33,
  internationalPackage,
  packageBooking,
  packageDetail,
  packageQuote,
} from '../fixtures/booking';
import { accountApi, resetAccountApi } from '../helpers/accountMock';
import { authState, renderWithClient, resetNavigation, router, signInAsGuest, signOut } from '../helpers/mocks';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);
jest.mock('@/api/endpoints/account', () => require('../helpers/accountMock').accountApiModule);
jest.mock('@/api/endpoints/booking', () => ({
  hotelApi: { detail: jest.fn(), quote: jest.fn(), create: jest.fn() },
  packageApi: { detail: jest.fn(), quote: jest.fn(), create: jest.fn() },
}));

const hotel = hotelApi as jest.Mocked<typeof hotelApi>;
const pkg = packageApi as jest.Mocked<typeof packageApi>;

const meera = savedTraveller();
const pickMeera = async (position = 0) => {
  await fireEvent.press((await screen.findAllByRole('button', { name: 'Use a saved traveller' }))[position]);
  await fireEvent.press(await screen.findByRole('button', { name: 'Meera Nair, Passport ending 567' }));
};

beforeEach(() => {
  resetAccountApi();
  _resetAttemptMemoryForTests();
  hotel.detail.mockReset().mockResolvedValue(hotelDetail);
  hotel.quote.mockReset().mockResolvedValue(hotelQuote);
  hotel.create.mockReset().mockResolvedValue(hotelBooking());
  pkg.detail.mockReset().mockResolvedValue(packageDetail());
  pkg.quote.mockReset().mockResolvedValue(packageQuote);
  pkg.create.mockReset().mockResolvedValue(packageBooking());
  accountApi.travellerApi.list.mockResolvedValue([meera]);
});

describe('choosing a saved traveller on a hotel booking', () => {
  const PARAMS = { hotelId: '1', roomId: '1', checkIn: IN_30, checkOut: IN_33, rooms: '1', adults: '2', children: '0' };
  beforeEach(() => resetNavigation(PARAMS, { pathname: '/book/hotel', segments: ['book', 'hotel'] }));

  it('fills that guest’s name, and the booking carries it', async () => {
    await renderWithClient(<BookHotelScreen />);
    await screen.findByText('Priced by our server');
    await pickMeera(1); // the second guest

    await waitFor(() => expect(screen.getAllByLabelText('First name')[1].props.value).toBe('Meera'));
    expect(screen.getAllByLabelText('Last name')[1].props.value).toBe('Nair');
    expect(screen.getAllByLabelText('First name')[0].props.value).toBe('Asha'); // the contact is untouched

    await fireEvent.press(screen.getByRole('button', { name: 'Confirm booking' }));
    await waitFor(() => expect(hotel.create).toHaveBeenCalledTimes(1));
    expect(hotel.create.mock.calls[0][0].guests.map((g) => [g.first_name, g.last_name])).toEqual([['Asha', 'Rao'], ['Meera', 'Nair']]);
  });

  it('offers nobody to choose from when none are saved', async () => {
    accountApi.travellerApi.list.mockResolvedValue([]);
    await renderWithClient(<BookHotelScreen />);
    await screen.findByText('Priced by our server');
    expect(screen.queryByRole('button', { name: 'Use a saved traveller' })).toBeNull();
  });

  it('offers none to a signed-out visitor, and asks for none of their saved details', async () => {
    signOut();
    await renderWithClient(<BookHotelScreen />);
    await screen.findByText('Priced by our server');
    expect(screen.queryByRole('button', { name: 'Use a saved traveller' })).toBeNull();
    expect(accountApi.travellerApi.list).not.toHaveBeenCalled();
  });
});

describe('choosing a saved traveller on a package booking', () => {
  const departureAhead = addDays(todayISO(), 30);

  describe('a domestic trip', () => {
    beforeEach(() => resetNavigation({ packageId: '7', departureId: '55', pax: '2' }, { pathname: '/book/package', segments: ['book', 'package'] }));

    it('fills the traveller’s name, and a saved child keeps their type on a later seat', async () => {
      accountApi.travellerApi.list.mockResolvedValue([savedTraveller({ traveller_type: 'child' })]);
      await renderWithClient(<BookPackageScreen />);
      await screen.findByText('Priced by our server');
      await pickMeera(1);

      await waitFor(() => expect(screen.getAllByLabelText('First name')[1].props.value).toBe('Meera'));
      await fireEvent.press(screen.getByRole('button', { name: 'Confirm booking' }));
      await waitFor(() => expect(pkg.create).toHaveBeenCalledTimes(1));
      expect(pkg.create.mock.calls[0][0].travellers.map((t) => [t.first_name, t.traveller_type])).toEqual([['Asha', 'adult'], ['Meera', 'child']]);
    });

    it('keeps the booking contact an adult, whoever is chosen for that seat', async () => {
      accountApi.travellerApi.list.mockResolvedValue([savedTraveller({ traveller_type: 'infant' })]);
      await renderWithClient(<BookPackageScreen />);
      await screen.findByText('Priced by our server');
      await pickMeera(0);

      await waitFor(() => expect(screen.getAllByLabelText('First name')[0].props.value).toBe('Meera'));
      await fireEvent.changeText(screen.getAllByLabelText('First name')[1], 'Ravi');
      await fireEvent.changeText(screen.getAllByLabelText('Last name')[1], 'Rao');
      await fireEvent.press(screen.getByRole('button', { name: 'Confirm booking' }));
      await waitFor(() => expect(pkg.create).toHaveBeenCalledTimes(1));
      expect(pkg.create.mock.calls[0][0].travellers[0]).toMatchObject({ first_name: 'Meera', traveller_type: 'adult', is_contact: true });
    });
  });

  describe('an international trip', () => {
    beforeEach(() => {
      pkg.detail.mockResolvedValue(internationalPackage);
      resetNavigation({ packageId: '12', departureId: '80', pax: '2' }, { pathname: '/book/package', segments: ['book', 'package'] });
    });

    it('fills the passport as well, so it is not typed again', async () => {
      await renderWithClient(<BookPackageScreen />);
      await screen.findByText('Priced by our server');
      await pickMeera(0);

      await waitFor(() => expect(screen.getAllByLabelText('Passport number')[0].props.value).toBe('N1234567'));
      expect(screen.getAllByLabelText('Passport expiry (YYYY-MM-DD)')[0].props.value).toBe('2034-09-01');
    });

    it('still applies the six-months rule to a saved passport that is too close to expiring', async () => {
      accountApi.travellerApi.list.mockResolvedValue([savedTraveller({ passport_expiry: addDays(departureAhead, 150) })]);
      await renderWithClient(<BookPackageScreen />);
      await screen.findByText('Priced by our server');
      await pickMeera(0);
      await waitFor(() => expect(screen.getAllByLabelText('First name')[0].props.value).toBe('Meera'));

      await fireEvent.changeText(screen.getAllByLabelText('First name')[1], 'Ravi');
      await fireEvent.changeText(screen.getAllByLabelText('Last name')[1], 'Rao');
      await fireEvent.changeText(screen.getAllByLabelText('Passport number')[1], 'N7654321');
      await fireEvent.changeText(screen.getAllByLabelText('Passport expiry (YYYY-MM-DD)')[1], addDays(departureAhead, 400));
      await fireEvent.press(screen.getByRole('button', { name: 'Confirm booking' }));

      expect((await screen.findAllByText('The passport must be valid for at least 6 months after the departure date.')).length).toBeGreaterThan(0);
      expect(pkg.create).not.toHaveBeenCalled();
    });
  });
});

describe('the sign-in screen, for a guest', () => {
  beforeEach(() => resetNavigation({}, { pathname: '/sign-in', segments: ['(auth)', 'sign-in'] }));

  it('offers a visitor to continue as a guest, then leaves the sign-in screen, which a guest session no longer removes', async () => {
    signOut();
    const { startGuest } = authState.current;
    await renderWithClient(<SignInScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Continue as guest' }));
    await waitFor(() => expect(startGuest).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('goes home instead when there is nowhere to go back to (opened straight on the sign-in screen)', async () => {
    signOut();
    router.canGoBack.mockReturnValue(false);
    await renderWithClient(<SignInScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Continue as guest' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(router.back).not.toHaveBeenCalled();
  });

  it('stays on the screen, with the reason, when a guest session cannot be started', async () => {
    signOut();
    (authState.current.startGuest as jest.Mock).mockRejectedValueOnce(new ApiError('network'));
    await renderWithClient(<SignInScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Continue as guest' }));
    expect(await screen.findByText(/Can't reach JackpotsWorld/)).toBeOnTheScreen();
    expect(router.back).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('does NOT offer a guest another guest session, which would strand what they have done; it says what signing in keeps', async () => {
    signInAsGuest();
    await renderWithClient(<SignInScreen />);

    expect(screen.queryByRole('button', { name: 'Continue as guest' })).toBeNull();
    expect(screen.getByText(/browsing as a guest\. Sign in and your bookings, wishlist and saved travellers come with you/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Send code' })).toBeOnTheScreen();
    expect(router.push).not.toHaveBeenCalled();
  });
});
