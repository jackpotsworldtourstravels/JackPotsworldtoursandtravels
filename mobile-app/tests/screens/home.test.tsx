import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { discoveryApi } from '@/api/endpoints/discovery';
import { engagementApi } from '@/api/endpoints/engagement';
import { systemApi } from '@/api/endpoints/system';
import { ApiError } from '@/api/errors';
import HomeScreen from '@/app/(tabs)/index';
import { DESTINATIONS, FINALE, HERO, PROMISE, TRUST } from '@/features/home/copy';

import { coupons, destinations, hotelList, packages } from '../fixtures/discovery';
import { deferred, renderWithClient, resetNavigation, router, signOut } from '../helpers/mocks';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);
jest.mock('@/api/endpoints/discovery', () => ({
  discoveryApi: { destinations: jest.fn(), hotels: jest.fn(), packages: jest.fn(), coupons: jest.fn() },
}));
jest.mock('@/api/endpoints/engagement', () => ({ engagementApi: { subscribeNewsletter: jest.fn() } }));
jest.mock('@/api/endpoints/system', () => ({
  FLIGHTS_OFF: { enabled: false, provider: null },
  systemApi: { health: jest.fn(), flightCapability: jest.fn() },
}));

const discovery = discoveryApi as jest.Mocked<typeof discoveryApi>;
const engagement = engagementApi as jest.Mocked<typeof engagementApi>;
const system = systemApi as jest.Mocked<typeof systemApi>;

beforeEach(() => {
  resetNavigation({}, { pathname: '/', segments: ['(tabs)'] });
  signOut();
  discovery.destinations.mockReset().mockResolvedValue(destinations);
  discovery.hotels.mockReset().mockResolvedValue(hotelList);
  discovery.packages.mockReset().mockResolvedValue(packages);
  discovery.coupons.mockReset().mockImplementation(async (product) => coupons[product as keyof typeof coupons] ?? []);
  engagement.subscribeNewsletter.mockReset().mockResolvedValue(undefined);
  system.health.mockReset().mockResolvedValue(true);
  system.flightCapability.mockReset().mockResolvedValue({ enabled: false, provider: 'demo' });
});

const email = () => screen.getByLabelText(FINALE.newsletter.label);

describe('Home is the website’s Home, in the app', () => {
  it('opens with the website’s headline, in its header, with the search dock', async () => {
    await renderWithClient(<HomeScreen />);
    expect(screen.getByRole('header', { name: `${HERO.line1} ${HERO.accent} ${HERO.line2}` })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Log in or create an account' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Menu' })).toBeOnTheScreen();
    expect(screen.getByRole('tab', { name: 'Flights' })).toBeSelected(); // the website opens on Flights
    // All four of the website's service tabs are there and reachable.
    for (const name of ['Flights', 'Hotels', 'Tour Packages', 'Gaming Tour Packages']) expect(screen.getByRole('tab', { name })).toBeOnTheScreen();
  });

  it('shows the website’s trust strip', async () => {
    await renderWithClient(<HomeScreen />);
    for (const t of TRUST) expect(screen.getByLabelText(`${t.title}. ${t.sub}`)).toBeOnTheScreen();
  });

  it('shows the destinations heading and the real destinations as the website’s numbered grid', async () => {
    await renderWithClient(<HomeScreen />);
    expect(screen.getByRole('header', { name: `${DESTINATIONS.title1} ${DESTINATIONS.title2}` })).toBeOnTheScreen();
    expect(screen.getByText(DESTINATIONS.lede)).toBeOnTheScreen();
    const goa = await screen.findByRole('button', { name: 'Explore Goa, India' });
    expect(goa).toBeOnTheScreen();
    await fireEvent.press(goa);
    expect(router.push).toHaveBeenCalledWith({ pathname: '/destination/[id]', params: { id: expect.any(String) } });
  });

  it('shows nine destinations first, then "View all N destinations" opens the rest, as the website does', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...destinations[0], id: `place-${i}`, name: `Place ${i}`, image: null }));
    discovery.destinations.mockResolvedValue(many);
    await renderWithClient(<HomeScreen />);
    expect(await screen.findByRole('button', { name: 'Explore Place 8, India' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Explore Place 9, India' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'View all 12 destinations' }));
    expect(screen.getByRole('button', { name: 'Explore Place 11, India' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'View all 12 destinations' })).toBeNull();
  });

  it('has only what the website’s Home has: no hotel shelf, package shelf or offers band, which the website removed', async () => {
    await renderWithClient(<HomeScreen />);
    await screen.findByRole('button', { name: 'Explore Goa, India' });
    expect(screen.queryByText('Featured stays')).toBeNull();
    expect(screen.queryByText('Tour packages')).toBeNull();
    expect(screen.queryByText('Make your trip go further.')).toBeNull();
    expect(discovery.hotels).not.toHaveBeenCalled();
    expect(discovery.packages).not.toHaveBeenCalled();
  });

  it('ends with the website’s footer: the closing band, its four columns, the contact details and the copyright bar', async () => {
    await renderWithClient(<HomeScreen />);
    expect(screen.getByRole('header', { name: /THE WORLD\s+AWAITS\./i })).toBeOnTheScreen();
    for (const heading of ['COMPANY', 'TRAVEL', 'LEGAL', 'CONTACT']) expect(screen.getByRole('header', { name: heading })).toBeOnTheScreen();
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toBeOnTheScreen();
    expect(screen.getByRole('link', { name: 'Gaming Packages' })).toBeOnTheScreen();
    expect(screen.getByRole('link', { name: 'Phone: +91 91778 47799' })).toBeOnTheScreen();
    expect(screen.getByText(/All Rights Reserved\./)).toBeOnTheScreen();
    expect(screen.getByText('SSL Secured')).toBeOnTheScreen();
  });

  it('shows all eight promises, in the website’s order', async () => {
    await renderWithClient(<HomeScreen />);
    expect(screen.getByRole('header', { name: PROMISE.statement.join(' ') })).toBeOnTheScreen();
    for (const item of PROMISE.items) expect(screen.getByLabelText(`${item.title}. ${item.body}`)).toBeOnTheScreen();
    expect(PROMISE.items).toHaveLength(8);
  });

  it('says nothing about flights or live chat that the app cannot do', async () => {
    await renderWithClient(<HomeScreen />);
    expect(screen.queryByText(/live chat/i)).toBeNull();
    expect(screen.queryByLabelText(/Flights, hotels and tours/)).toBeNull();
    expect(screen.queryByLabelText(/chat and call/)).toBeNull();
  });

  it('"Plan your journey" opens Help and support', async () => {
    await renderWithClient(<HomeScreen />);
    // The finale and the footer band both carry the call to action; both go to Help and support.
    const buttons = screen.getAllByRole('button', { name: FINALE.cta });
    expect(buttons).toHaveLength(2);
    await fireEvent.press(buttons[0]);
    expect(router.push).toHaveBeenCalledWith('/support');
  });

  it('destinations failing does not take the page down', async () => {
    discovery.destinations.mockRejectedValue(new ApiError('network'));
    await renderWithClient(<HomeScreen />);
    expect(await screen.findByText('Couldn’t load destinations')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: `${HERO.line1} ${HERO.accent} ${HERO.line2}` })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Search Flights' })).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'CONTACT' })).toBeOnTheScreen(); // the footer is still there
  });
});

describe('development tooling is not part of the page', () => {
  it('prints no diagnostics under the footer, and no Reload control of its own: that belongs to the development build', async () => {
    await renderWithClient(<HomeScreen />);
    expect(screen.queryByText(/Development build/)).toBeNull();
    expect(screen.queryByText(/Check again/)).toBeNull();
    expect(screen.queryByText(/reload/i)).toBeNull();
  });

  it('a long press on the copyright line opens the diagnostics, for development builds only', async () => {
    await renderWithClient(<HomeScreen />);
    await fireEvent(screen.getByText(/All Rights Reserved\./), 'longPress');
    expect(await screen.findByText('Development build')).toBeOnTheScreen();
  });
});

describe('the newsletter signup', () => {
  it('sends the tidied address and confirms in the website’s words, clearing the field', async () => {
    await renderWithClient(<HomeScreen />);
    await fireEvent.changeText(email(), '  asha@example.com ');
    await fireEvent.press(screen.getByRole('button', { name: FINALE.newsletter.button }));
    await waitFor(() => expect(engagement.subscribeNewsletter).toHaveBeenCalledWith('asha@example.com'));
    expect(await screen.findByText(FINALE.newsletter.success)).toBeOnTheScreen();
    expect(email().props.value).toBe('');
  });

  it('refuses something that is not an email address before asking the server', async () => {
    await renderWithClient(<HomeScreen />);
    await fireEvent.changeText(email(), 'not-an-email');
    await fireEvent.press(screen.getByRole('button', { name: FINALE.newsletter.button }));
    expect(await screen.findByText('Enter a valid email address.')).toBeOnTheScreen();
    expect(engagement.subscribeNewsletter).not.toHaveBeenCalled();
  });

  it('on any failure says the website’s sentence, never the server’s text, and keeps the address to retry', async () => {
    engagement.subscribeNewsletter.mockRejectedValue(new ApiError('server', { status: 503, message: 'We couldn’t subscribe you right now: mail inbox ops@example.com' }));
    await renderWithClient(<HomeScreen />);
    await fireEvent.changeText(email(), 'asha@example.com');
    await fireEvent.press(screen.getByRole('button', { name: FINALE.newsletter.button }));
    expect(await screen.findByText(FINALE.newsletter.error)).toBeOnTheScreen();
    expect(screen.queryByText(/ops@example\.com/)).toBeNull();
    expect(email().props.value).toBe('asha@example.com');
  });

  it('sends once however often Subscribe is pressed while the request is open', async () => {
    const open = deferred();
    engagement.subscribeNewsletter.mockReturnValue(open.promise);
    await renderWithClient(<HomeScreen />);
    await fireEvent.changeText(email(), 'asha@example.com');
    const subscribe = screen.getByRole('button', { name: FINALE.newsletter.button });
    await fireEvent.press(subscribe);
    await fireEvent.press(subscribe);
    await fireEvent.press(subscribe);
    open.resolve();
    await screen.findByText(FINALE.newsletter.success);
    expect(engagement.subscribeNewsletter).toHaveBeenCalledTimes(1);
  });
});
