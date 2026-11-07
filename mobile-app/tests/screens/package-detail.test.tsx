import { fireEvent, screen } from '@testing-library/react-native';

import { packageApi } from '@/api/endpoints/booking';
import { ApiError } from '@/api/errors';
import PackageDetailScreen from '@/app/packages/[id]';
import { formatLongDate } from '@/utils/dates';

import { IN_30, LAST_MONTH, packageDetail } from '../fixtures/booking';
import { renderWithClient, resetNavigation, router } from '../helpers/mocks';
import { resetAccountApi } from '../helpers/accountMock';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);
jest.mock('@/api/endpoints/account', () => require('../helpers/accountMock').accountApiModule);
jest.mock('@/api/endpoints/booking', () => ({ packageApi: { detail: jest.fn() } }));

const api = packageApi as jest.Mocked<typeof packageApi>;

beforeEach(() => {
  resetAccountApi();
  api.detail.mockReset().mockResolvedValue(packageDetail());
  resetNavigation({ id: '7' });
});

describe('package page', () => {
  it('shows what is included and what is not, the day by day in order, the hotels and the policy', async () => {
    await renderWithClient(<PackageDetailScreen />);

    expect(await screen.findByText('Four days across North and South Goa.')).toBeOnTheScreen();
    expect(screen.getByText('Daily breakfast')).toBeOnTheScreen();
    // "Flights" is under "Not included" and is also a link in the site footer that now ends the page.
    expect(screen.getAllByText('Flights')).toHaveLength(2);
    expect(screen.getByText('Sea View Resort')).toBeOnTheScreen();
    expect(screen.getByText('Free cancellation up to 7 days before departure.')).toBeOnTheScreen();

    const days = screen.getAllByText(/^Day \d/).map((el) => String(el.props.children).replace(/,/g, ''));
    expect(days[0]).toMatch(/Day 1/);
    expect(days[1]).toMatch(/Day 2/);
  });

  it('offers only departures that can still be booked, and labels their prices indicative', async () => {
    await renderWithClient(<PackageDetailScreen />);
    await screen.findByText('Departures');

    expect(screen.getAllByRole('radio')).toHaveLength(1); // not the one that has left, not the sold-out one
    expect(screen.getByRole('radio', { name: new RegExp(formatLongDate(IN_30)) })).toBeOnTheScreen();
    expect(screen.queryByText(formatLongDate(LAST_MONTH))).toBeNull();
    expect(screen.getByText('Indicative')).toBeOnTheScreen();
    expect(screen.getByText(/Indicative price: taken from our listing/)).toBeOnTheScreen();
    expect(screen.queryByText(/Priced by our server/)).toBeNull();
  });

  it('carries the departure and traveller count to the booking screen, by id only', async () => {
    await renderWithClient(<PackageDetailScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Continue to booking' }));

    expect(router.push).toHaveBeenCalledWith({
      pathname: '/book/package',
      params: { packageId: '7', departureId: '55', pax: '2' },
    });
    expect(Object.keys(router.push.mock.calls[0][0].params).filter((k) => /price|amount|total/i.test(k))).toEqual([]);
  });

  it('keeps the traveller count within the seats left', async () => {
    await renderWithClient(<PackageDetailScreen />);
    await screen.findByText('Departures');

    for (let i = 0; i < 6; i += 1) await fireEvent.press(screen.getByRole('button', { name: 'More travellers' }));
    expect(screen.getByRole('button', { name: 'More travellers' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Continue to booking' }));
    expect(router.push.mock.calls[0][0].params.pax).toBe('4'); // the departure has 4 seats left
  });

  it('offers an enquiry, not a booking, when nothing is open for sale', async () => {
    api.detail.mockResolvedValue(packageDetail({ departures: [{ id: 49, date: LAST_MONTH, price: '21900.00', seats_left: 7 }] }));
    await renderWithClient(<PackageDetailScreen />);

    expect(await screen.findByText('No departure dates are open for booking right now')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Continue to booking' })).toBeNull();
    // The site's hero offers the enquiry too; the departures card repeats it with the explanation.
    const enquire = screen.getAllByRole('button', { name: 'Enquire about dates' });
    expect(enquire).toHaveLength(2);
    await fireEvent.press(enquire[0]);
    expect(router.push).toHaveBeenCalledWith({ pathname: '/packages/enquire', params: { packageId: '7', packageName: 'Goa' } });
  });

  it('copes with a package that has no itinerary, hotels or exclusions yet', async () => {
    api.detail.mockResolvedValue(packageDetail({ itinerary: [], hotels: [], exclusions: [], inclusions: [], description: null }));
    await renderWithClient(<PackageDetailScreen />);
    expect(await screen.findByText('North and South Goa beaches.')).toBeOnTheScreen(); // falls back to the blurb
    expect(screen.queryByText('Itinerary')).toBeNull();
    expect(screen.queryByText('Not included')).toBeNull();
  });

  it('says so for an unknown package, and does not ask for a hostile id', async () => {
    api.detail.mockRejectedValueOnce(new ApiError('not_found', { status: 404 }));
    await renderWithClient(<PackageDetailScreen />);
    expect(await screen.findByText('We couldn’t find that package')).toBeOnTheScreen();
  });

  it('refuses a hostile id without a request', async () => {
    resetNavigation({ id: '7/../x' });
    api.detail.mockClear();
    await renderWithClient(<PackageDetailScreen />);
    expect(await screen.findByText('We couldn’t find that package')).toBeOnTheScreen();
    expect(api.detail).not.toHaveBeenCalled();
  });
});
