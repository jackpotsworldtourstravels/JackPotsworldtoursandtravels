import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { notificationsApi } from '@/api/endpoints/account';
import { hotelApi, packageApi } from '@/api/endpoints/booking';
import { discoveryApi } from '@/api/endpoints/discovery';
import { systemApi } from '@/api/endpoints/system';
import { ApiError } from '@/api/errors';
import HomeScreen from '@/app/(tabs)/index';

import { hotelBooking } from '../fixtures/booking';
import { coupons, destinations, hotelList, packages } from '../fixtures/discovery';
import { renderWithClient, resetNavigation, router, signIn, signOut } from '../helpers/mocks';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);
jest.mock('@/api/endpoints/discovery', () => ({
  discoveryApi: { destinations: jest.fn(), hotels: jest.fn(), packages: jest.fn(), coupons: jest.fn() },
}));
jest.mock('@/api/endpoints/account', () => ({
  notificationsApi: { unreadCount: jest.fn(), list: jest.fn(), markAllRead: jest.fn() },
}));
jest.mock('@/api/endpoints/booking', () => ({ hotelApi: { list: jest.fn() }, packageApi: { list: jest.fn() } }));
jest.mock('@/api/endpoints/system', () => ({
  FLIGHTS_OFF: { enabled: false, provider: null },
  systemApi: { health: jest.fn(), flightCapability: jest.fn() },
}));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));

const discovery = discoveryApi as jest.Mocked<typeof discoveryApi>;
const notifications = notificationsApi as jest.Mocked<typeof notificationsApi>;
const hotels = hotelApi as jest.Mocked<typeof hotelApi>;
const pkgs = packageApi as jest.Mocked<typeof packageApi>;
const system = systemApi as jest.Mocked<typeof systemApi>;

beforeEach(() => {
  resetNavigation({}, { pathname: '/', segments: ['(tabs)'] });
  signOut();
  discovery.destinations.mockReset().mockResolvedValue(destinations);
  discovery.hotels.mockReset().mockResolvedValue(hotelList);
  discovery.packages.mockReset().mockResolvedValue(packages);
  discovery.coupons.mockReset().mockImplementation(async (product) => coupons[product as keyof typeof coupons] ?? []);
  notifications.unreadCount.mockReset().mockResolvedValue(0);
  hotels.list.mockReset().mockResolvedValue([]);
  pkgs.list.mockReset().mockResolvedValue([]);
  system.health.mockReset().mockResolvedValue(true);
  system.flightCapability.mockReset().mockResolvedValue({ enabled: false, provider: 'demo' });
});

describe('Home: the header', () => {
  it('welcomes a visitor, and greets a customer by first name', async () => {
    await renderWithClient(<HomeScreen />);
    expect(screen.getByRole('header', { name: 'Welcome' })).toBeOnTheScreen();

    signIn();
    await renderWithClient(<HomeScreen />);
    expect(screen.getByRole('header', { name: /^Good (morning|afternoon|evening), Asha$/ })).toBeOnTheScreen();
  });

  it('has the menu at the left, and notifications and the profile at the right', async () => {
    await renderWithClient(<HomeScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Notifications' }));
    expect(router.push).toHaveBeenLastCalledWith('/notifications');
    await fireEvent.press(screen.getByRole('button', { name: 'Your profile' }));
    expect(router.push).toHaveBeenLastCalledWith('/profile');
  });

  it('says how many notifications are unread on the bell', async () => {
    signIn();
    notifications.unreadCount.mockResolvedValue(3);
    await renderWithClient(<HomeScreen />);
    expect(await screen.findByRole('button', { name: 'Notifications, 3 unread' })).toBeOnTheScreen();
  });

  it('opens the menu, which lists every part of the app and goes where it says', async () => {
    signIn();
    await renderWithClient(<HomeScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Open menu' }));
    for (const label of ['My trips', 'Wishlist', 'Offers and coupons', 'Saved travellers', 'Payments and refunds', 'Help and support']) {
      expect(screen.getByText(label)).toBeOnTheScreen();
    }
    expect(screen.getByText('Log out')).toBeOnTheScreen();
    await fireEvent.press(screen.getByText('Offers and coupons'));
    expect(router.push).toHaveBeenLastCalledWith('/offers');
  });

  it('offers a guest to log in from the menu instead of logging out', async () => {
    await renderWithClient(<HomeScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Open menu' }));
    expect(screen.getByText('Log in or create an account')).toBeOnTheScreen();
    expect(screen.queryByText('Log out')).toBeNull();
  });
});

describe('Home: search comes first', () => {
  it('opens on hotels, and switches to holidays and flights in place; Gaming Tour Packages are nowhere', async () => {
    await renderWithClient(<HomeScreen />);
    expect(screen.getByRole('tab', { name: 'Hotels' })).toBeSelected();
    expect(screen.getByRole('button', { name: 'Search hotels' })).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('tab', { name: 'Holidays' }));
    expect(screen.getByRole('button', { name: 'Search packages' })).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('tab', { name: 'Flights' }));
    expect(screen.getByRole('button', { name: 'Search Flights' })).toBeOnTheScreen();
    expect(screen.queryByText(/Gaming/)).toBeNull();
  });

  it('hands a flight search to the flights screen', async () => {
    await renderWithClient(<HomeScreen />);
    await fireEvent.press(screen.getByRole('tab', { name: 'Flights' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Search Flights' }));
    const call = router.push.mock.calls.at(-1)?.[0];
    expect(call.pathname).toBe('/flights');
    expect(JSON.parse(call.params.search)).toMatchObject({ trip: 'oneway', from: 'HYD', to: 'DEL' });
  });
});

describe('Home: what needs the customer next', () => {
  it('shows an unpaid trip first, with Pay now, and opens it by reference', async () => {
    signIn();
    hotels.list.mockResolvedValue([hotelBooking({ created_at: '2026-10-20T10:00:00Z' })]);
    await renderWithClient(<HomeScreen />);
    expect(await screen.findByText('Pay now')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: /^Taj Palace, .*, pay now$/ }));
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/booking/[ref]', params: { ref: 'JPH000123' } });
  });

  it('shows no trip card when there is nothing booked', async () => {
    signIn();
    await renderWithClient(<HomeScreen />);
    await screen.findByRole('button', { name: 'Explore Goa, India' });
    expect(screen.queryByText('Pay now')).toBeNull();
    expect(screen.queryByText('Upcoming')).toBeNull();
  });

  it('shows live offers as vouchers, each opening the search it applies to, with See all going to Offers', async () => {
    await renderWithClient(<HomeScreen />);
    const hotelOffer = await screen.findByRole('button', { name: /STAYMORE$/ });
    await fireEvent.press(hotelOffer);
    expect(router.push).toHaveBeenLastCalledWith('/search/hotels');
    await fireEvent.press(screen.getByRole('link', { name: 'See all: Offers for you' }));
    expect(router.push).toHaveBeenLastCalledWith('/offers');
  });
});

describe('Home: the catalogue', () => {
  it('shows real destinations, each opening its page, with See all going to Explore', async () => {
    await renderWithClient(<HomeScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Explore Goa, India' }));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/destination/[id]', params: { id: 'goa' } });
    await fireEvent.press(screen.getByRole('link', { name: 'See all: Popular destinations' }));
    expect(router.push).toHaveBeenLastCalledWith('/explore');
  });

  it('features best-rated hotels, never one without a rating such as the internal test listing', async () => {
    await renderWithClient(<HomeScreen />);
    await waitFor(() => expect(screen.getByText('Taj Palace')).toBeOnTheScreen());
    expect(screen.queryByText('TEST PROPERTY - payment verification')).toBeNull();
  });

  it('features holiday packages only, never a gaming package', async () => {
    discovery.packages.mockResolvedValue([...packages, { ...packages[0], id: '99', name: 'Casino Nights', category: 'gaming' }]);
    await renderWithClient(<HomeScreen />);
    await waitFor(() => expect(screen.getByText('North Goa Heritage Tour')).toBeOnTheScreen());
    expect(screen.queryByText('Casino Nights')).toBeNull();
  });

  it('a section that fails to load says so with a retry, and does not take the page down', async () => {
    discovery.destinations.mockRejectedValueOnce(new ApiError('network'));
    await renderWithClient(<HomeScreen />);
    expect(await screen.findByText('Couldn’t load popular destinations.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Search hotels' })).toBeOnTheScreen();
    await waitFor(() => expect(screen.getByText('Taj Palace')).toBeOnTheScreen());
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Explore Goa, India' })).toBeOnTheScreen();
  });

  it('says nothing about live chat, and prints no development diagnostics', async () => {
    await renderWithClient(<HomeScreen />);
    expect(screen.queryByText(/live chat/i)).toBeNull();
    expect(screen.queryByText(/Development build/)).toBeNull();
  });
});
