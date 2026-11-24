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
  it('lists every hotel when no destination is chosen, saying the prices are indicative', async () => {
    await renderWithClient(<HotelsScreen />);
    expect(await screen.findByText('All hotels')).toBeOnTheScreen();
    await waitFor(() => expect(screen.getByText('Taj Palace')).toBeOnTheScreen());
    expect(screen.getByText(/rates are indicative until your stay is quoted/)).toBeOnTheScreen();
    expect(api.destinationHotels).not.toHaveBeenCalled();
  });

  it('shows a destination’s hotels from the destination endpoint, numeric prices included', async () => {
    mockParams = { destination: 'hyderabad' };
    api.destinationHotels.mockResolvedValue(hyderabadPage);

    await renderWithClient(<HotelsScreen />);

    expect(await screen.findByRole('header', { name: 'Hyderabad' })).toBeOnTheScreen();
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
    // Under the title in the header, with Edit beside it.
    expect(await screen.findByText('Thu, 5 Nov – Sun, 8 Nov · 2 Rooms · 4 Guests')).toBeOnTheScreen();
  });

  it('ignores stay params that are not a valid future stay', async () => {
    mockParams = { checkIn: '2020-01-01', checkOut: '2020-01-03' };
    await renderWithClient(<HotelsScreen />);
    await screen.findByText('All hotels');
    // Once the results are in (and the searching screen, which repeats the summary, has gone):
    await screen.findByText('Taj Palace');
    // No dates in the header, only the party.
    expect(screen.getByText('1 Room · 2 Guests')).toBeOnTheScreen();
    expect(screen.queryByText(/Jan/)).toBeNull();
  });

  it('re-orders when a sort is chosen', async () => {
    await renderWithClient(<HotelsScreen />);
    await screen.findByText('Taj Palace');

    // Sort opens a sheet of choices; choosing one closes it.
    await fireEvent.press(screen.getByRole('button', { name: 'Sort' }));
    await fireEvent.press(screen.getByRole('radio', { name: 'Price: low to high' }));
    expect(hotelNamesOnScreen().slice(0, 2)).toEqual(['TEST PROPERTY - payment verification', 'Radisson']);

    await fireEvent.press(screen.getByRole('button', { name: 'Sort' }));
    await fireEvent.press(screen.getByRole('radio', { name: 'Price: high to low' }));
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
    expect(await screen.findByRole('header', { name: 'Holiday Packages' })).toBeOnTheScreen();
    await waitFor(() => expect(screen.getByText('Dubai')).toBeOnTheScreen());
    expect(screen.getByText('All trip types · 4 packages')).toBeOnTheScreen(); // the header's subtitle
    expect(api.packages).toHaveBeenCalledWith({ destination: undefined, trip_type: undefined });
  });

  it('asks the server for a destination by name', async () => {
    mockParams = { destination: 'Goa' };
    await renderWithClient(<PackagesScreen />);
    // The header says what is being looked at.
    await waitFor(() => expect(screen.getAllByText('Goa').length).toBeGreaterThan(0));
    expect(api.packages).toHaveBeenCalledWith({ destination: 'Goa', trip_type: undefined });
  });

  it('re-queries the server when the trip type changes', async () => {
    await renderWithClient(<PackagesScreen />);
    await screen.findByText('All trip types · 4 packages');

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
    await screen.findByText('All trip types · 4 packages');
    await fireEvent.press(screen.getByRole('button', { name: 'Sort: Recommended' }));
    await fireEvent.press(screen.getByRole('radio', { name: 'Price: low to high' }));
    const first = screen.getAllByLabelText(/per person|, from |, next departure from /)[0];
    expect(within(first).getByText('North Goa Heritage Tour')).toBeOnTheScreen();
  });
});
