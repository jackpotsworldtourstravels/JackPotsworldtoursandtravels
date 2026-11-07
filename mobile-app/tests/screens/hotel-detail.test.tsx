import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { hotelApi } from '@/api/endpoints/booking';
import { ApiError } from '@/api/errors';
import HotelDetailScreen from '@/app/hotels/[id]';

import { hotelDetail, IN_30, IN_33 } from '../fixtures/booking';
import { renderWithClient, resetNavigation, router } from '../helpers/mocks';
import { resetAccountApi } from '../helpers/accountMock';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);
jest.mock('@/api/endpoints/account', () => require('../helpers/accountMock').accountApiModule);
jest.mock('@/api/endpoints/booking', () => ({ hotelApi: { detail: jest.fn() } }));

const api = hotelApi as jest.Mocked<typeof hotelApi>;

beforeEach(() => {
  resetAccountApi();
  api.detail.mockReset().mockResolvedValue(hotelDetail);
  resetNavigation({ id: '1', checkIn: IN_30, checkOut: IN_33, rooms: '1', adults: '2', children: '0' });
});

describe('hotel page', () => {
  it('shows the hotel, its facts, amenities and policy from the backend', async () => {
    await renderWithClient(<HotelDetailScreen />);

    expect(await screen.findByText('Banjara Hills, Hyderabad')).toBeOnTheScreen();
    expect(screen.getByText('A landmark five-star address in the heart of Banjara Hills.')).toBeOnTheScreen();
    expect(screen.getByText('Spa')).toBeOnTheScreen();
    expect(screen.getByText('24 km from the airport')).toBeOnTheScreen();
    expect(screen.getAllByText('Free cancellation up to 48 hours before check-in.').length).toBeGreaterThan(0);
    expect(api.detail).toHaveBeenCalledWith(1);
  });

  it('keeps the photo safeguard: the Hyderabad "Taj Palace" shows a city photo, labelled, never the Mumbai Taj', async () => {
    await renderWithClient(<HotelDetailScreen />);
    expect(await screen.findByText('Destination photo, not this hotel')).toBeOnTheScreen();
    expect(screen.getByLabelText(/not of Taj Palace/)).toBeOnTheScreen();
  });

  it('labels every room price "Indicative rate", never as a quote', async () => {
    await renderWithClient(<HotelDetailScreen />);
    await screen.findByText('Superior Room');
    expect(screen.getAllByText('Indicative rate')).toHaveLength(2);
    expect(screen.getByText(/Indicative rate: taken from our listing/)).toBeOnTheScreen();
    expect(screen.queryByText(/Priced by our server/)).toBeNull();
    expect(screen.getByText(/₹12,500/)).toBeOnTheScreen();
  });

  it('carries the chosen room, dates and guests to the booking screen as route params only', async () => {
    await renderWithClient(<HotelDetailScreen />);
    await screen.findByText('Superior Room');

    await fireEvent.press(screen.getAllByRole('button', { name: 'Select this room' })[0]);

    expect(router.push).toHaveBeenCalledWith({
      pathname: '/book/hotel',
      params: { hotelId: '1', roomId: '1', checkIn: IN_30, checkOut: IN_33, rooms: '1', adults: '2', children: '0' },
    });
    // No price travels in the route.
    const params = router.push.mock.calls[0][0].params;
    expect(Object.keys(params).filter((k) => /price|amount|total/i.test(k))).toEqual([]);
  });

  it('will not let a room be chosen that cannot sleep the party, and says why', async () => {
    resetNavigation({ id: '1', checkIn: IN_30, checkOut: IN_33, rooms: '1', adults: '3', children: '0' });
    await renderWithClient(<HotelDetailScreen />);
    await screen.findByText('Superior Room');

    expect(screen.getAllByRole('button', { name: 'Select this room' })[0]).toBeDisabled();
    expect(screen.getByText('Sleeps up to 2. Add rooms or choose a larger one.')).toBeOnTheScreen();
    expect(screen.getAllByRole('button', { name: 'Select this room' })[1]).toBeEnabled(); // the suite sleeps 4
    await fireEvent.press(screen.getAllByRole('button', { name: 'Select this room' })[0]);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('will not let more rooms of a type be chosen than exist', async () => {
    resetNavigation({ id: '1', checkIn: IN_30, checkOut: IN_33, rooms: '2', adults: '2', children: '0' });
    await renderWithClient(<HotelDetailScreen />);
    await screen.findByText('Deluxe Suite');
    expect(screen.getByText('Only 1 of this room type.')).toBeOnTheScreen();
    expect(screen.getAllByRole('button', { name: 'Select this room' })[1]).toBeDisabled();
  });

  it('falls back to a valid stay when the route’s dates are in the past or nonsense', async () => {
    resetNavigation({ id: '1', checkIn: '2020-01-01', checkOut: '2020-01-03', adults: '2' });
    await renderWithClient(<HotelDetailScreen />);
    await screen.findByText('Superior Room');
    await fireEvent.press(screen.getAllByRole('button', { name: 'Select this room' })[0]);

    const { checkIn, checkOut } = router.push.mock.calls[0][0].params;
    expect(checkIn > '2020-01-03').toBe(true);
    expect(checkOut > checkIn).toBe(true);
  });

  it('says so when the hotel is not found, or the id is not a number, and asks for nothing', async () => {
    api.detail.mockRejectedValueOnce(new ApiError('not_found', { status: 404 }));
    await renderWithClient(<HotelDetailScreen />);
    expect(await screen.findByText('We couldn’t find that hotel')).toBeOnTheScreen();
  });

  it('refuses a hostile id without a request', async () => {
    resetNavigation({ id: '1; DROP TABLE' });
    api.detail.mockClear();
    await renderWithClient(<HotelDetailScreen />);
    expect(await screen.findByText('We couldn’t find that hotel')).toBeOnTheScreen();
    expect(api.detail).not.toHaveBeenCalled();
  });

  it('offers a retry on a network failure and recovers', async () => {
    api.detail.mockRejectedValueOnce(new ApiError('network'));
    await renderWithClient(<HotelDetailScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('Superior Room')).toBeOnTheScreen());
  });
});
