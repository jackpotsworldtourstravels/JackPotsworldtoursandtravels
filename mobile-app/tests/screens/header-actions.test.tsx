import { fireEvent, screen } from '@testing-library/react-native';

import { HeaderActions, MENU_ITEMS } from '@/components/HeaderActions';

import { authState, renderWithClient, resetNavigation, router, signInAsGuest, signOut } from '../helpers/mocks';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);

beforeEach(() => {
  resetNavigation({}, { pathname: '/', segments: ['(tabs)'] });
});

describe('the website header actions, in the app header', () => {
  it('signed out: offers LOGIN / CREATE, which goes to sign-in', async () => {
    signOut();
    await renderWithClient(<HeaderActions />);
    expect(screen.getByText('LOGIN / CREATE')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Your profile' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Log in or create an account' }));
    expect(router.push).toHaveBeenCalledWith('/sign-in');
  });

  it('a guest has no account, so they are offered sign-in too, not a profile chip', async () => {
    signInAsGuest();
    await renderWithClient(<HeaderActions />);
    expect(screen.getByRole('button', { name: 'Log in or create an account' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Your profile' })).toBeNull();
  });

  it('signed in: shows the customer’s initial and opens the profile, with no LOGIN pill', async () => {
    await renderWithClient(<HeaderActions />);
    expect(authState.current.status).toBe('customer');
    expect(screen.getByText('A')).toBeOnTheScreen();
    expect(screen.queryByText('LOGIN / CREATE')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Your profile' }));
    expect(router.push).toHaveBeenCalledWith('/profile');
  });

  it('the heart opens the wishlist', async () => {
    await renderWithClient(<HeaderActions />);
    await fireEvent.press(screen.getByRole('button', { name: 'Wishlist' }));
    expect(router.push).toHaveBeenCalledWith('/wishlist');
  });

  it('the menu lists every service and each one navigates and closes the sheet', async () => {
    await renderWithClient(<HeaderActions />);
    expect(screen.queryByRole('button', { name: 'Hotels' })).toBeNull(); // closed until opened
    await fireEvent.press(screen.getByRole('button', { name: 'Menu' }));

    for (const item of MENU_ITEMS) expect(screen.getByRole('button', { name: item.title })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Flights' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Gaming Tour Packages' })).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Gaming Tour Packages' }));
    expect(router.push).toHaveBeenCalledWith('/gaming');
    expect(screen.queryByRole('button', { name: 'Gaming Tour Packages' })).toBeNull();
  });

  it('opens Flights from the menu', async () => {
    await renderWithClient(<HeaderActions />);
    await fireEvent.press(screen.getByRole('button', { name: 'Menu' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Flights' }));
    expect(router.push).toHaveBeenCalledWith('/flights');
  });

  it('the menu is the website’s drawer, in its order: Flights, Hotels, Tour Packages, Gaming Tour Packages, Contact', () => {
    expect(MENU_ITEMS.map((i) => [i.title, i.href])).toEqual([
      ['Flights', '/flights'],
      ['Hotels', '/hotels'],
      ['Tour Packages', '/packages'],
      ['Gaming Tour Packages', '/gaming'],
      ['Contact', '/support'],
    ]);
  });

  it('the drawer numbers the five links, then offers My trips, Partner sign in and the phone and email, as the website’s does', async () => {
    await renderWithClient(<HeaderActions />);
    await fireEvent.press(screen.getByRole('button', { name: 'Menu' }));
    for (const n of ['01', '02', '03', '04', '05']) expect(screen.getByText(n)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'My trips' })).toBeOnTheScreen();
    expect(screen.getByRole('link', { name: 'Partner sign in' })).toBeOnTheScreen();
    expect(screen.getByRole('link', { name: /^Call \+91/ })).toBeOnTheScreen();
    expect(screen.getByRole('link', { name: 'Email support@jackpotsworldtours.com' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'My trips' }));
    expect(router.push).toHaveBeenCalledWith('/bookings');
    await fireEvent.press(screen.getByRole('button', { name: 'Menu' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Close menu' }));
    expect(screen.queryByRole('button', { name: 'Close menu' })).toBeNull();
  });
});
