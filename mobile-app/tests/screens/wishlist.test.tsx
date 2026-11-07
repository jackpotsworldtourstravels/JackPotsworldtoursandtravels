import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { hotelApi, packageApi } from '@/api/endpoints/booking';
import { ApiError } from '@/api/errors';
import WishlistScreen from '@/app/(tabs)/wishlist';
import { WishlistButton } from '@/features/account/components/WishlistButton';
import { returnTo } from '@/features/auth/returnTo';

import { wishlistItem } from '../fixtures/account';
import { hotelDetail, packageDetail } from '../fixtures/booking';
import { accountApi, resetAccountApi } from '../helpers/accountMock';
import { deferred, renderWithClient, resetNavigation, router, signInAsGuest, signOut } from '../helpers/mocks';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);
jest.mock('@/api/endpoints/account', () => require('../helpers/accountMock').accountApiModule);
jest.mock('@/api/endpoints/booking', () => ({ hotelApi: { detail: jest.fn() }, packageApi: { detail: jest.fn() } }));

const hotel = hotelApi as jest.Mocked<typeof hotelApi>;
const pkg = packageApi as jest.Mocked<typeof packageApi>;

beforeEach(() => {
  resetAccountApi();
  returnTo.clear();
  hotel.detail.mockReset().mockResolvedValue(hotelDetail);
  pkg.detail.mockReset().mockResolvedValue(packageDetail());
  resetNavigation({}, { pathname: '/wishlist', segments: ['(tabs)', 'wishlist'] });
});

describe('the wishlist tab', () => {
  const saved = [
    wishlistItem({ id: 501, item_type: 'hotel', item_id: 1 }),
    wishlistItem({ id: 502, item_type: 'package', item_id: 7 }),
  ];

  it('shows saved hotels and packages from the same pages the app already uses', async () => {
    accountApi.wishlistApi.list.mockResolvedValue(saved);
    await renderWithClient(<WishlistScreen />);

    expect(await screen.findByText('2 saved items')).toBeOnTheScreen();
    expect(await screen.findByText(hotelDetail.name)).toBeOnTheScreen();
    expect(await screen.findByText(packageDetail().name)).toBeOnTheScreen();
    expect(hotel.detail).toHaveBeenCalledWith(1);
    expect(pkg.detail).toHaveBeenCalledWith(7);
  });

  it('opens a saved hotel or package on its own page', async () => {
    accountApi.wishlistApi.list.mockResolvedValue(saved);
    await renderWithClient(<WishlistScreen />);

    await fireEvent.press(await screen.findByRole('button', { name: new RegExp(`^${hotelDetail.name},`) }));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/hotels/[id]', params: { id: '1' } });
    await fireEvent.press(await screen.findByRole('button', { name: new RegExp(`^${packageDetail().name}`) }));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/packages/[id]', params: { id: '7' } });
  });

  it('counts, and says so, what was saved on the website that the app cannot open (flights, cruises)', async () => {
    accountApi.wishlistApi.list.mockResolvedValue([...saved, wishlistItem({ id: 503, item_type: 'flight', item_id: 99 }), wishlistItem({ id: 504, item_type: 'cruise', item_id: 3 })]);
    await renderWithClient(<WishlistScreen />);

    expect(await screen.findByText('2 saved items')).toBeOnTheScreen();
    expect(screen.getByText(/2 items saved on our website \(flights or cruises\) aren’t shown in the app/)).toBeOnTheScreen();
  });

  it('removes an item through the server and drops the row', async () => {
    accountApi.wishlistApi.list.mockResolvedValueOnce(saved).mockResolvedValue([saved[1]]);
    await renderWithClient(<WishlistScreen />);

    await fireEvent.press(await screen.findByRole('button', { name: `Remove ${hotelDetail.name} from wishlist` }));
    await waitFor(() => expect(accountApi.wishlistApi.remove).toHaveBeenCalledWith(501));
    await waitFor(() => expect(screen.queryByText(hotelDetail.name)).toBeNull());
    expect(screen.getByText(packageDetail().name)).toBeOnTheScreen();
  });

  it('sends one removal even if Remove is pressed again while the first is still out', async () => {
    const gate = deferred<void>();
    accountApi.wishlistApi.list.mockResolvedValue([saved[0]]);
    accountApi.wishlistApi.remove.mockImplementation(() => gate.promise);
    await renderWithClient(<WishlistScreen />);

    const name = `Remove ${hotelDetail.name} from wishlist`;
    await fireEvent.press(await screen.findByRole('button', { name }));
    await fireEvent.press(screen.getByRole('button', { name }));
    await waitFor(() => expect(accountApi.wishlistApi.remove).toHaveBeenCalledTimes(1));

    gate.resolve();
    await waitFor(() => expect(screen.getByRole('button', { name })).toBeEnabled());
    expect(accountApi.wishlistApi.remove).toHaveBeenCalledTimes(1);
  });

  it('says so, and offers removal, for an item that is no longer listed', async () => {
    accountApi.wishlistApi.list.mockResolvedValue([saved[0]]);
    hotel.detail.mockRejectedValue(new ApiError('not_found', { status: 404, message: 'Hotel not found' }));
    await renderWithClient(<WishlistScreen />);

    expect(await screen.findByText('This hotel is no longer listed')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Remove this hotel from wishlist' }));
    await waitFor(() => expect(accountApi.wishlistApi.remove).toHaveBeenCalledWith(501));
  });

  it('does not call a network problem "no longer listed"', async () => {
    accountApi.wishlistApi.list.mockResolvedValue([saved[0]]);
    hotel.detail.mockRejectedValue(new ApiError('network'));
    await renderWithClient(<WishlistScreen />);
    expect(await screen.findByText('We couldn’t load this hotel right now')).toBeOnTheScreen();
    expect(screen.queryByText(/no longer listed/)).toBeNull();
  });

  it('shows an empty wishlist plainly, and points to where to start', async () => {
    await renderWithClient(<WishlistScreen />);
    expect(await screen.findByText('Nothing saved yet')).toBeOnTheScreen();
    // The footer band's "Explore destinations" comes after the empty state's own button.
    await fireEvent.press(screen.getAllByRole('button', { name: 'Explore destinations' })[0]);
    expect(router.push).toHaveBeenCalledWith('/explore');
  });

  it('shows a guest their own wishlist: it is kept and moves to an account later', async () => {
    signInAsGuest();
    accountApi.wishlistApi.list.mockResolvedValue([saved[0]]);
    await renderWithClient(<WishlistScreen />);
    expect(await screen.findByText(hotelDetail.name)).toBeOnTheScreen();
  });

  it('asks a signed-out visitor to sign in, and fetches nothing', async () => {
    signOut();
    await renderWithClient(<WishlistScreen />);
    expect(await screen.findByText('Your wishlist')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(accountApi.wishlistApi.list).not.toHaveBeenCalled();
  });

  it('offers a retry when the list cannot be loaded', async () => {
    accountApi.wishlistApi.list.mockRejectedValueOnce(new ApiError('network')).mockResolvedValue([]);
    await renderWithClient(<WishlistScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByText('Nothing saved yet')).toBeOnTheScreen();
  });
});

describe('the Save to wishlist button', () => {
  beforeEach(() => resetNavigation({}, { pathname: '/hotels/1', segments: ['hotels', '1'] }));

  /** The button shows a spinner and ignores presses while the list loads; wait until it can be used. */
  async function usable(name: string) {
    await screen.findByRole('button', { name });
    await waitFor(() => expect(screen.getByRole('button', { name })).toBeEnabled());
    return screen.getByRole('button', { name });
  }

  it('reads Saved when the server already has it, and nothing is sent for just showing it', async () => {
    accountApi.wishlistApi.list.mockResolvedValue([wishlistItem({ id: 501, item_type: 'hotel', item_id: 1 })]);
    await renderWithClient(<WishlistButton type="hotel" id={1} />);
    expect(await screen.findByRole('button', { name: 'Saved to wishlist' })).toBeOnTheScreen();
    expect(accountApi.wishlistApi.add).not.toHaveBeenCalled();
  });

  it('is not fooled by another kind of item with the same id', async () => {
    accountApi.wishlistApi.list.mockResolvedValue([wishlistItem({ id: 502, item_type: 'package', item_id: 1 })]);
    await renderWithClient(<WishlistButton type="hotel" id={1} />);
    expect(await screen.findByRole('button', { name: 'Save to wishlist' })).toBeOnTheScreen();
  });

  it('saves, then un-saves, following the server each time', async () => {
    const row = wishlistItem({ id: 777, item_type: 'hotel', item_id: 1 });
    accountApi.wishlistApi.add.mockResolvedValue(row);
    accountApi.wishlistApi.list.mockResolvedValueOnce([]).mockResolvedValueOnce([row]).mockResolvedValue([]);
    await renderWithClient(<WishlistButton type="hotel" id={1} />);

    await fireEvent.press(await usable('Save to wishlist'));
    expect(await screen.findByRole('button', { name: 'Saved to wishlist' })).toBeOnTheScreen();
    expect(accountApi.wishlistApi.add).toHaveBeenCalledWith('hotel', 1);

    await fireEvent.press(await usable('Saved to wishlist'));
    await waitFor(() => expect(accountApi.wishlistApi.remove).toHaveBeenCalledWith(777));
    expect(await screen.findByRole('button', { name: 'Save to wishlist' })).toBeOnTheScreen();
  });

  it('cannot be tapped twice while a request is out', async () => {
    const gate = deferred<ReturnType<typeof wishlistItem>>();
    accountApi.wishlistApi.add.mockImplementation(() => gate.promise);
    await renderWithClient(<WishlistButton type="package" id={7} />);

    await fireEvent.press(await usable('Save to wishlist'));
    await fireEvent.press(screen.getByRole('button', { name: /wishlist/i }));
    await fireEvent.press(screen.getByRole('button', { name: /wishlist/i }));
    // Still out: the presses above did nothing. Only now does the answer arrive.
    await waitFor(() => expect(accountApi.wishlistApi.add).toHaveBeenCalledTimes(1));
    gate.resolve(wishlistItem({ id: 9, item_type: 'package', item_id: 7 }));
    // Let everything finish (the refresh after saving too) before the test ends.
    await waitFor(() => expect(screen.getByRole('button', { name: /wishlist/i })).toBeEnabled());
    expect(accountApi.wishlistApi.add).toHaveBeenCalledTimes(1);
  });

  it('says so, and stays unsaved, when saving fails', async () => {
    accountApi.wishlistApi.add.mockRejectedValue(new ApiError('server'));
    await renderWithClient(<WishlistButton type="hotel" id={1} />);
    await fireEvent.press(await usable('Save to wishlist'));
    expect(await screen.findByText('Something went wrong on our side. Please try again.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Save to wishlist' })).toBeOnTheScreen();
  });

  it('sends a signed-out visitor to sign in and saves nothing on their behalf', async () => {
    signOut();
    await renderWithClient(<WishlistButton type="hotel" id={1} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Save to wishlist' }));

    expect(router.push).toHaveBeenCalledWith('/sign-in');
    expect(returnTo.isPending()).toBe(true); // they come back here afterwards
    expect(accountApi.wishlistApi.add).not.toHaveBeenCalled();
    expect(accountApi.wishlistApi.list).not.toHaveBeenCalled();
  });
});
