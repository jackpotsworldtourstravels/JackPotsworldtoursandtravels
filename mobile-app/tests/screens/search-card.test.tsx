import { fireEvent, screen } from '@testing-library/react-native';

import { discoveryApi } from '@/api/endpoints/discovery';
import { HotelSearchForm, PackageSearchForm } from '@/features/search/SearchCard';
import { addDays, formatMonthYear, todayISO } from '@/utils/dates';

import { destinations } from '../fixtures/discovery';
import { renderWithClient, resetNavigation, router } from '../helpers/mocks';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);
jest.mock('@/api/endpoints/discovery', () => ({ discoveryApi: { destinations: jest.fn() } }));

const api = discoveryApi as jest.Mocked<typeof discoveryApi>;

beforeEach(() => {
  api.destinations.mockReset().mockResolvedValue(destinations);
  resetNavigation();
});

const tomorrow = () => addDays(todayISO(), 1);

// The flight form is covered by flights.test.tsx. Gaming Tour Packages are disabled, so there is no gaming form.
describe('hotel search form passes the search on correctly', () => {
  it('sends destination, dates, rooms and guests to the hotel results, validated', async () => {
    await renderWithClient(<HotelSearchForm />);
    await fireEvent.press(screen.getByRole('button', { name: /^Destination:/ }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Hyderabad, India' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Search hotels' }));

    expect(router.push).toHaveBeenCalledWith({
      pathname: '/hotels',
      params: {
        destination: 'hyderabad',
        checkIn: tomorrow(),
        checkOut: addDays(tomorrow(), 1),
        rooms: '1',
        adults: '2',
        children: '0',
      },
    });
  });

  it('searches every destination when none is chosen, by sending no destination at all', async () => {
    await renderWithClient(<HotelSearchForm />);
    await fireEvent.press(screen.getByRole('button', { name: 'Search hotels' }));
    const params = router.push.mock.calls[0][0].params;
    expect(params).not.toHaveProperty('destination');
    expect(params.checkIn).toBe(tomorrow());
  });

  it('carries a changed party', async () => {
    await renderWithClient(<HotelSearchForm />);
    await fireEvent.press(screen.getByRole('button', { name: /^Guests and rooms:/ }));
    await fireEvent.press(screen.getByRole('button', { name: 'More rooms' }));
    await fireEvent.press(screen.getByRole('button', { name: 'More children' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Search hotels' }));

    expect(router.push.mock.calls[0][0].params).toMatchObject({ rooms: '2', adults: '2', children: '1' });
  });

  it('moves check-out along when check-in is pushed past it, so a range is never impossible', async () => {
    await renderWithClient(<HotelSearchForm />);
    const later = addDays(todayISO(), 10);
    await fireEvent.press(screen.getByRole('button', { name: /^Check-in:/ }));
    const day = Number(later.slice(8));
    const monthLabel = formatMonthYear(Number(later.slice(0, 4)), Number(later.slice(5, 7)) - 1);
    // The calendar lists the months one under another; pick the day, then close it.
    await fireEvent.press(screen.getByRole('button', { name: new RegExp(`^\\w+ ${day} ${monthLabel}`) }));
    await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Search hotels' }));

    const { checkIn, checkOut } = router.push.mock.calls[0][0].params;
    expect(checkIn).toBe(later);
    expect(checkOut).toBe(addDays(later, 1));
  });
});

describe('package search form passes the search on correctly', () => {
  it('sends a destination NAME to package results, because that is what the packages endpoint filters on', async () => {
    await renderWithClient(<PackageSearchForm />);
    await fireEvent.press(screen.getByRole('button', { name: /^Destination:/ }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Dubai, United Arab Emirates' }));
    await fireEvent.press(screen.getByRole('tab', { name: 'International' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Search packages' }));

    expect(router.push).toHaveBeenCalledWith({ pathname: '/packages', params: { destination: 'Dubai', tripType: 'international' } });
  });

  it('sends no filters at all when nothing is chosen', async () => {
    await renderWithClient(<PackageSearchForm />);
    await fireEvent.press(screen.getByRole('button', { name: 'Search packages' }));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/packages', params: {} });
  });
});
