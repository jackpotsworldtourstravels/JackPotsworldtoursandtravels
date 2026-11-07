import { fireEvent, screen } from '@testing-library/react-native';

import { discoveryApi } from '@/api/endpoints/discovery';
import { SearchCard } from '@/features/search/SearchCard';
import { addDays, todayISO } from '@/utils/dates';

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

describe('search card passes the search on correctly', () => {
  it('offers the website’s four service tabs, in its order, and opens on Flights, as the website does', async () => {
    await renderWithClient(<SearchCard />);
    // The order the website's search card uses (booking-card.js): Flights, Hotels, Tour Packages, Gaming Tour Packages.
    const tabs = screen.getAllByRole('tab').map((t) => t.props.accessibilityLabel);
    expect(tabs.slice(0, 4)).toEqual(['Flights', 'Hotels', 'Tour Packages', 'Gaming Tour Packages']);
    expect(screen.getByRole('tab', { name: 'Flights' })).toBeSelected();
    // The three reassurances are inside the card, under the form, on every tab.
    expect(screen.getByLabelText('Secure Payments. SSL secured')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('tab', { name: 'Hotels' }));
    expect(screen.getByLabelText('24/7 Support. Always here for you')).toBeOnTheScreen();
  });

  it('the Flights tab asks what the website asks, and a search carries to the Flights screen; it never shows a fare or a Book button', async () => {
    await renderWithClient(<SearchCard />);
    await fireEvent.press(screen.getByRole('tab', { name: 'Flights' }));
    expect(screen.getByRole('tab', { name: 'One Way' })).toBeSelected();
    expect(screen.getByRole('button', { name: /^From Airport:/ })).toBeOnTheScreen();
    expect(screen.queryByText(/₹/)).toBeNull();
    expect(screen.queryByRole('button', { name: /book/i })).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'Search Flights' }));
    expect(router.push).toHaveBeenCalledTimes(1);
    const call = router.push.mock.calls[0][0];
    expect(call.pathname).toBe('/flights');
    expect(JSON.parse(call.params.search)).toMatchObject({ trip: 'oneway', from: 'HYD', to: 'DEL', cabin: 'Economy', fare: 'regular', party: { adults: 1, children: 0, infants: 0 } });
  });

  it('the Flights tab refuses an impossible search, in the website’s words, and goes nowhere', async () => {
    await renderWithClient(<SearchCard />);
    await fireEvent.press(screen.getByRole('tab', { name: 'Flights' }));
    await fireEvent.press(screen.getByRole('tab', { name: 'Round Trip' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Search Flights' }));
    expect(await screen.findByText('Choose a return date, or switch to One Way.')).toBeOnTheScreen();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('the Gaming Tour Packages tab is an enquiry, as on the website: a note and a link to the form, no search', async () => {
    await renderWithClient(<SearchCard />);
    await fireEvent.press(screen.getByRole('tab', { name: 'Gaming Tour Packages' }));
    expect(screen.getByText(/Gaming Tour Packages are arranged by our desk, one traveller at a time\. Open the enquiry form/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Search/ })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Open the enquiry form' }));
    expect(router.push).toHaveBeenCalledWith('/gaming');
  });

  it('sends destination, dates, rooms and guests to the hotel results, validated', async () => {
    await renderWithClient(<SearchCard initialTab="hotels" />);
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
    await renderWithClient(<SearchCard initialTab="hotels" />);
    await fireEvent.press(screen.getByRole('button', { name: 'Search hotels' }));
    const params = router.push.mock.calls[0][0].params;
    expect(params).not.toHaveProperty('destination');
    expect(params.checkIn).toBe(tomorrow());
  });

  it('carries a changed party', async () => {
    await renderWithClient(<SearchCard initialTab="hotels" />);
    await fireEvent.press(screen.getByRole('button', { name: /^Guests and rooms:/ }));
    await fireEvent.press(screen.getByRole('button', { name: 'More rooms' }));
    await fireEvent.press(screen.getByRole('button', { name: 'More children' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Search hotels' }));

    expect(router.push.mock.calls[0][0].params).toMatchObject({ rooms: '2', adults: '2', children: '1' });
  });

  it('moves check-out along when check-in is pushed past it, so a range is never impossible', async () => {
    await renderWithClient(<SearchCard initialTab="hotels" />);
    const later = addDays(todayISO(), 10);
    await fireEvent.press(screen.getByRole('button', { name: /^Check-in:/ }));
    const day = Number(later.slice(8));
    const monthLabel = new Date(Number(later.slice(0, 4)), Number(later.slice(5, 7)) - 1, day).toLocaleString('en-US', { month: 'long', year: 'numeric' });
    // Walk to the right month, then pick the day.
    for (let i = 0; i < 2 && !screen.queryByText(monthLabel); i += 1) await fireEvent.press(screen.getByRole('button', { name: 'Next month' }));
    await fireEvent.press(screen.getByRole('button', { name: new RegExp(`^\\w+ ${day} ${monthLabel}`) }));
    await fireEvent.press(screen.getByRole('button', { name: 'Search hotels' }));

    const { checkIn, checkOut } = router.push.mock.calls[0][0].params;
    expect(checkIn).toBe(later);
    expect(checkOut).toBe(addDays(later, 1));
  });

  it('sends a destination NAME to package results, because that is what the packages endpoint filters on', async () => {
    await renderWithClient(<SearchCard initialTab="hotels" />);
    await fireEvent.press(screen.getByRole('tab', { name: 'Tour Packages' }));
    await fireEvent.press(screen.getByRole('button', { name: /^Destination:/ }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Dubai, United Arab Emirates' }));
    await fireEvent.press(screen.getByRole('button', { name: 'International' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Search packages' }));

    expect(router.push).toHaveBeenCalledWith({ pathname: '/packages', params: { destination: 'Dubai', tripType: 'international' } });
  });
});
