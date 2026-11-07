import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import { discoveryApi } from '@/api/endpoints/discovery';
import { ApiError } from '@/api/errors';
import HotelsScreen from '@/app/hotels/index';
import PackagesScreen from '@/app/packages/index';

import { destinations, emptyGoaPage, hotelList, hyderabadPage, packages } from '../fixtures/discovery';

const mockPush = jest.fn();
let mockParams: Record<string, string> = {};

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => mockParams,
}));

jest.mock('@/api/endpoints/discovery', () => ({
  discoveryApi: {
    destinations: jest.fn(),
    hotels: jest.fn(),
    destinationHotels: jest.fn(),
    packages: jest.fn(),
  },
}));

const api = discoveryApi as jest.Mocked<typeof discoveryApi>;

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** The hotel names on screen, top to bottom. */
function hotelNamesOnScreen(): string[] {
  const all = [...hotelList.map((h) => h.name), ...hyderabadPage.hotels.map((h) => h.name)];
  return screen
    .getAllByLabelText(/, \d star,/)
    .map((el) => String(el.props.accessibilityLabel).split(',')[0])
    .filter((n) => all.includes(n));
}

beforeEach(() => {
  mockPush.mockReset();
  mockParams = {};
  Object.values(api).forEach((fn) => (fn as jest.Mock).mockReset());
  api.destinations.mockResolvedValue(destinations);
  api.hotels.mockResolvedValue(hotelList);
  api.packages.mockResolvedValue(packages);
});

describe('hotel results', () => {
  it('lists every hotel when no destination is chosen, with the honesty banner about prices', async () => {
    await renderWithClient(<HotelsScreen />);
    expect(await screen.findByText('All hotels')).toBeOnTheScreen();
    await waitFor(() => expect(screen.getByText('Taj Palace')).toBeOnTheScreen());
    expect(screen.getByText(/Prices are indicative nightly rates/)).toBeOnTheScreen();
    expect(api.destinationHotels).not.toHaveBeenCalled();
  });

  it('shows a destination’s hotels from the destination endpoint, numeric prices included', async () => {
    mockParams = { destination: 'hyderabad' };
    api.destinationHotels.mockResolvedValue(hyderabadPage);

    await renderWithClient(<HotelsScreen />);

    expect(await screen.findByText('Hotels in Hyderabad')).toBeOnTheScreen();
    await waitFor(() => expect(screen.getByText('Radisson')).toBeOnTheScreen());
    expect(screen.getByText(/₹6,400/)).toBeOnTheScreen();
    expect(screen.getByText(/₹12,500\.50/)).toBeOnTheScreen();
    expect(api.hotels).not.toHaveBeenCalled();
    expect(api.destinationHotels).toHaveBeenCalledWith('hyderabad', { page: 1, locationId: undefined });
  });

  it('says plainly that a destination has no hotels yet, and offers its packages', async () => {
    mockParams = { destination: 'goa' };
    api.destinationHotels.mockResolvedValue(emptyGoaPage);

    await renderWithClient(<HotelsScreen />);

    expect(await screen.findByText('No hotels in Goa yet')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Tour packages in Goa' }));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/packages', params: { destination: 'Goa' } });
  });

  it('shows the stay the customer chose, from validated route params only', async () => {
    mockParams = { checkIn: '2099-11-05', checkOut: '2099-11-08', rooms: '2', adults: '3', children: '1' };
    await renderWithClient(<HotelsScreen />);
    // The hero's summary card and its date ribbon: the site prints "SAT, 24 OCT – SUN, 25 OCT · 1 ROOM · 2 GUESTS".
    expect(await screen.findByText('Thu, 5 Nov – Sun, 8 Nov · 2 rooms · 4 guests')).toBeOnTheScreen();
    expect(screen.getByLabelText('Check-in 5 Nov, check-out 8 Nov')).toBeOnTheScreen();
  });

  it('ignores stay params that are not a valid future stay', async () => {
    mockParams = { checkIn: '2020-01-01', checkOut: '2020-01-03' };
    await renderWithClient(<HotelsScreen />);
    await screen.findByText('All hotels');
    expect(screen.queryByLabelText('Your stay')).toBeNull();
  });

  it('re-orders when a sort is chosen', async () => {
    await renderWithClient(<HotelsScreen />);
    await screen.findByText('Taj Palace');

    await fireEvent.press(screen.getByRole('button', { name: 'Price: low to high' }));
    expect(hotelNamesOnScreen().slice(0, 2)).toEqual(['TEST PROPERTY - payment verification', 'Radisson']);

    await fireEvent.press(screen.getByRole('button', { name: 'Price: high to low' }));
    expect(hotelNamesOnScreen()[0]).toBe('Taj Palace');
  });

  it('filters by free cancellation and by stars, and can clear the filters', async () => {
    await renderWithClient(<HotelsScreen />);
    await screen.findByText('Taj Palace');

    await fireEvent.press(screen.getByRole('button', { name: 'Free cancellation' }));
    expect(screen.queryByText('Hyatt Regency')).toBeNull(); // the one without it
    expect(screen.getByText('Taj Palace')).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: '5 stars' }));
    expect(hotelNamesOnScreen()).toEqual(['Taj Palace', 'Marriott']);
  });

  it('explains an empty filter result and offers to clear it', async () => {
    api.hotels.mockResolvedValue([hotelList[3]]); // a 4-star
    await renderWithClient(<HotelsScreen />);
    await screen.findByText('Radisson');

    await fireEvent.press(screen.getByRole('button', { name: '5 stars' }));
    expect(screen.getByText('No hotels match these filters')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('Radisson')).toBeOnTheScreen();
  });

  it('shows a calm error with a retry, and recovers', async () => {
    api.hotels.mockRejectedValueOnce(new ApiError('network'));
    await renderWithClient(<HotelsScreen />);

    expect(await screen.findByText("You're offline")).toBeOnTheScreen();
    api.hotels.mockResolvedValue(hotelList);
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Taj Palace')).toBeOnTheScreen();
  });
});

describe('package results', () => {
  it('lists packages, newest bookable first', async () => {
    await renderWithClient(<PackagesScreen />);
    expect(await screen.findByText('Tour packages')).toBeOnTheScreen(); // the breadcrumb
    expect(screen.getByRole('header', { name: 'Journeys, already planned.' })).toBeOnTheScreen();
    await waitFor(() => expect(screen.getByText('Dubai')).toBeOnTheScreen());
    expect(screen.getByText('4 PACKAGES')).toBeOnTheScreen();
    expect(api.packages).toHaveBeenCalledWith({ destination: undefined, trip_type: undefined });
  });

  it('asks the server for a destination by name', async () => {
    mockParams = { destination: 'Goa' };
    await renderWithClient(<PackagesScreen />);
    // The hero's summary card says what is being looked at.
    await waitFor(() => expect(screen.getAllByText('Goa').length).toBeGreaterThan(0));
    expect(api.packages).toHaveBeenCalledWith({ destination: 'Goa', trip_type: undefined });
  });

  it('re-queries the server when the trip type changes', async () => {
    await renderWithClient(<PackagesScreen />);
    await screen.findByText('4 PACKAGES');

    await fireEvent.press(screen.getByRole('button', { name: 'International' }));
    await waitFor(() => expect(api.packages).toHaveBeenLastCalledWith({ destination: undefined, trip_type: 'international' }));
  });

  it('starts on a trip type given in the route, and ignores an invalid one', async () => {
    mockParams = { tripType: 'international' };
    await renderWithClient(<PackagesScreen />);
    await waitFor(() => expect(api.packages).toHaveBeenCalledWith({ destination: undefined, trip_type: 'international' }));
  });

  it('ignores an invalid trip type in the route', async () => {
    mockParams = { tripType: 'drop table' };
    await renderWithClient(<PackagesScreen />);
    await waitFor(() => expect(api.packages).toHaveBeenCalledWith({ destination: undefined, trip_type: undefined }));
  });

  it('shows an empty state with a way back to all trip types', async () => {
    mockParams = { tripType: 'domestic' };
    // Nothing of that kind, though the whole list has packages (the category cards count the whole list).
    api.packages.mockImplementation(async (q) => (q?.trip_type ? [] : packages));
    await renderWithClient(<PackagesScreen />);

    expect(await screen.findByText('No packages found')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Show all trip types' }));
    expect(await screen.findByText('Dubai')).toBeOnTheScreen();
  });

  it('puts the cheapest actual price first when sorted by price', async () => {
    await renderWithClient(<PackagesScreen />);
    await screen.findByText('4 PACKAGES');
    await fireEvent.press(screen.getByRole('button', { name: 'Price: low to high' }));
    const first = screen.getAllByLabelText(/per person|, from |, next departure from /)[0];
    expect(within(first).getByText('North Goa Heritage Tour')).toBeOnTheScreen();
  });
});
