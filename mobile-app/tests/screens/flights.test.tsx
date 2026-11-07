import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { engagementApi } from '@/api/endpoints/engagement';
import { ApiError } from '@/api/errors';
import FlightsScreen from '@/app/flights/index';
import { defaultFlightSearch, type FlightSearch } from '@/features/flights/flightForm';
import { FLIGHT_QUOTE_SUBJECT } from '@/features/flights/flightQuote';
import { UNAVAILABLE_BODY, UNAVAILABLE_TITLE } from '@/features/flights/FlightsUnavailable';
import { todayISO } from '@/utils/dates';

import { deferred, renderWithClient, resetNavigation, signOut } from '../helpers/mocks';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);
jest.mock('@/api/endpoints/engagement', () => ({ engagementApi: { subscribeNewsletter: jest.fn(), sendContactMessage: jest.fn() } }));
jest.mock('@/api/endpoints/system', () => ({
  FLIGHTS_OFF: { enabled: false, provider: null },
  systemApi: { health: jest.fn(), flightCapability: jest.fn() },
}));

const engagement = engagementApi as jest.Mocked<typeof engagementApi>;
const today = todayISO();
const searchParam = (over: Partial<FlightSearch> = {}) => JSON.stringify({ ...defaultFlightSearch(today), ...over });
const searchFlights = () => fireEvent.press(screen.getByRole('button', { name: 'Search Flights' }));

beforeEach(() => {
  engagement.sendContactMessage.mockReset().mockResolvedValue(undefined);
  resetNavigation({}, { pathname: '/flights', segments: ['flights'] });
});

describe('the Flights screen asks what the website asks', () => {
  it('shows the website’s fields: trip type, airports with a swap, date, passengers, cabin, special fare', async () => {
    await renderWithClient(<FlightsScreen />);
    expect(screen.getByRole('tab', { name: 'One Way' })).toBeSelected();
    expect(screen.getByRole('tab', { name: 'Round Trip' })).toBeOnTheScreen();
    expect(screen.getByRole('tab', { name: 'Multi City' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: /^From Airport: Hyderabad \(HYD\)/ })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: /^To Airport: Delhi \(DEL\)/ })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Swap origin and destination' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: /^Departure:/ })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Passengers: 1 Adult' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Cabin: Economy' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Cabin: Economy' }));
    for (const cabin of ['Economy', 'Premium Economy', 'Business', 'First']) expect(screen.getByRole('button', { name: cabin })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Business' }));
    expect(screen.getByRole('button', { name: 'Cabin: Business' })).toBeOnTheScreen();
    for (const fare of ['Regular', 'Student', 'Armed Forces', 'Senior Citizen', 'Marine Fare']) expect(screen.getByRole('button', { name: fare })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Search Flights' })).toBeOnTheScreen();
  });

  it('swaps origin and destination', async () => {
    await renderWithClient(<FlightsScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Swap origin and destination' }));
    expect(screen.getByRole('button', { name: /^From Airport: Delhi \(DEL\)/ })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: /^To Airport: Hyderabad \(HYD\)/ })).toBeOnTheScreen();
  });

  it('picks an airport from the website’s list, with a search box', async () => {
    await renderWithClient(<FlightsScreen />);
    await fireEvent.press(screen.getByRole('button', { name: /^To Airport:/ }));
    await fireEvent.changeText(screen.getByLabelText('City or airport'), 'bang');
    expect(screen.getByRole('button', { name: 'Bangkok (BKK)' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Delhi (DEL)' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Bangkok (BKK)' }));
    expect(screen.getByRole('button', { name: /^To Airport: Bangkok \(BKK\)/ })).toBeOnTheScreen();
  });

  it('enforces the passenger rules as the buttons are pressed', async () => {
    await renderWithClient(<FlightsScreen />);
    await fireEvent.press(screen.getByRole('button', { name: /^Passengers:/ }));
    // One adult: one child at most, one infant at most.
    await fireEvent.press(screen.getByRole('button', { name: 'More children' }));
    await fireEvent.press(screen.getByRole('button', { name: 'More infants' }));
    expect(screen.getByRole('button', { name: 'More children' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'More infants' })).toBeDisabled();
    // Fewer adults than children or infants would be an impossible party, so adults cannot go below one.
    expect(screen.getByRole('button', { name: 'Fewer adults' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('button', { name: 'Passengers: 1 Adult, 1 Child, 1 Infant' })).toBeOnTheScreen();
  });

  it('round trip and one way ask for what they need, in the website’s words', async () => {
    await renderWithClient(<FlightsScreen />);
    await fireEvent.press(screen.getByRole('tab', { name: 'Round Trip' }));
    expect(screen.getByRole('button', { name: /^Return:/ })).toBeOnTheScreen();
    await searchFlights();
    expect(await screen.findByText('Choose a return date, or switch to One Way.')).toBeOnTheScreen();
    expect(screen.queryByText(UNAVAILABLE_TITLE)).toBeNull(); // nothing is "searched" while the form is wrong

    await fireEvent.press(screen.getByRole('tab', { name: 'One Way' }));
    expect(screen.queryByRole('button', { name: /^Return:/ })).toBeNull();
  });

  it('multi city: two flights to start, up to five, each checked by number', async () => {
    await renderWithClient(<FlightsScreen />);
    await fireEvent.press(screen.getByRole('tab', { name: 'Multi City' }));
    expect(screen.getByText('Flight 1')).toBeOnTheScreen();
    expect(screen.getByText('Flight 2')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Remove flight/ })).toBeNull(); // two is the minimum

    await searchFlights();
    expect(await screen.findByText('Choose where flight 2 arrives.')).toBeOnTheScreen();

    for (let i = 0; i < 3; i += 1) await fireEvent.press(screen.getByRole('button', { name: 'Add another flight' }));
    expect(screen.getByText('Flight 5')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Add another flight' })).toBeDisabled();
    expect(screen.getByText('Up to 5 flights in one itinerary.')).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Remove flight 5' }));
    expect(screen.queryByText('Flight 5')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add another flight' })).toBeEnabled();
  });
});

describe('what a flight search leads to', () => {
  it('says live fares are not available and nothing can be booked or paid, instead of showing anything that looks like a fare', async () => {
    await renderWithClient(<FlightsScreen />);
    expect(screen.queryByText(UNAVAILABLE_TITLE)).toBeNull(); // nothing until a search
    await searchFlights();

    expect(await screen.findByText(UNAVAILABLE_TITLE)).toBeOnTheScreen();
    expect(screen.getByText(UNAVAILABLE_BODY)).toBeOnTheScreen();
    expect(UNAVAILABLE_BODY).toMatch(/we do not show fares/);
    expect(UNAVAILABLE_BODY).toMatch(/cannot take a flight booking or a payment/);
    // Their own search is read back, so they can see what would be quoted.
    expect(screen.getByText(/Hyderabad \(HYD\) to Delhi \(DEL\), departing/)).toBeOnTheScreen();
    // No fare, no sample schedule, no Book or Pay.
    expect(screen.queryByText(/₹/)).toBeNull();
    expect(screen.queryByText(/sample/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /book|pay|select/i })).toBeNull();
  });

  it('carries a search from Home and reads it back at once', async () => {
    resetNavigation({ search: searchParam({ trip: 'round', ret: today, cabin: 'Business', fare: 'armed', party: { adults: 2, children: 1, infants: 0 } }) }, { pathname: '/flights', segments: ['flights'] });
    await renderWithClient(<FlightsScreen />);
    expect(await screen.findByText(UNAVAILABLE_TITLE)).toBeOnTheScreen();
    expect(screen.getByText('2 Adults, 1 Child · Business · Armed Forces fare')).toBeOnTheScreen();
    expect(screen.getByRole('tab', { name: 'Round Trip' })).toBeSelected();
  });

  it('ignores a search parameter that is not a well-formed search', async () => {
    resetNavigation({ search: '{"trip":"oneway","from":"XXX"}' }, { pathname: '/flights', segments: ['flights'] });
    await renderWithClient(<FlightsScreen />);
    expect(screen.queryByText(UNAVAILABLE_TITLE)).toBeNull();
    expect(screen.getByRole('button', { name: 'Search Flights' })).toBeOnTheScreen();
  });
});

describe('asking the team for a quote', () => {
  const open = async () => {
    await renderWithClient(<FlightsScreen />);
    await searchFlights();
    await screen.findByText(UNAVAILABLE_TITLE);
  };

  it('starts with the signed-in customer’s name and email, and emails the desk the trip, saying no fare was shown', async () => {
    await open();
    expect(screen.getByLabelText('Your name').props.value).toBe('Asha Rao');
    expect(screen.getByLabelText('Email we can reply to').props.value).toBe('asha@example.com');
    await fireEvent.changeText(screen.getByLabelText('Mobile number (optional)'), '+919876543210');
    await fireEvent.press(screen.getByRole('button', { name: 'Request a quote' }));

    await waitFor(() => expect(engagement.sendContactMessage).toHaveBeenCalledTimes(1));
    const sent = engagement.sendContactMessage.mock.calls[0][0];
    expect(sent).toMatchObject({ name: 'Asha Rao', email: 'asha@example.com', subject: FLIGHT_QUOTE_SUBJECT });
    expect(sent.message).toContain('Hyderabad (HYD) to Delhi (DEL)');
    expect(sent.message).toContain('Mobile: +919876543210');
    expect(sent.message).toContain('The app showed no fares and took no booking or payment for this trip.');
    expect(await screen.findByText(/We’ve sent your flight request to our team\. They will reply to asha@example\.com\. No fare has been quoted yet, and nothing has been booked or charged\./)).toBeOnTheScreen();
  });

  it('needs a name and a valid email, and sends nothing without them', async () => {
    signOut();
    await open();
    await fireEvent.press(screen.getByRole('button', { name: 'Request a quote' }));
    expect(await screen.findByText('Tell us your name.')).toBeOnTheScreen();
    expect(screen.getByText('Enter an email address we can reply to.')).toBeOnTheScreen();
    expect(engagement.sendContactMessage).not.toHaveBeenCalled();
  });

  it('when the desk cannot be reached, says so with the phone and email, never "sent"', async () => {
    engagement.sendContactMessage.mockRejectedValueOnce(new ApiError('server', { status: 503, message: 'mail is down at someone@example.com' }));
    await open();
    await fireEvent.press(screen.getByRole('button', { name: 'Request a quote' }));
    expect(await screen.findByText(/couldn’t send that just now/)).toBeOnTheScreen();
    expect(screen.getByText(/\+91 91778 47799 or email support@jackpotsworldtours\.com/)).toBeOnTheScreen();
    expect(screen.queryByText(/someone@example\.com/)).toBeNull();
    expect(screen.queryByText(/We’ve sent your flight request/)).toBeNull();
  });

  it('after a lost answer, says it may have arrived, and sends nothing behind the customer’s back', async () => {
    engagement.sendContactMessage.mockRejectedValueOnce(new ApiError('timeout'));
    await open();
    await fireEvent.press(screen.getByRole('button', { name: 'Request a quote' }));
    expect(await screen.findByText(/couldn’t confirm that your request reached us/)).toBeOnTheScreen();
    expect(engagement.sendContactMessage).toHaveBeenCalledTimes(1);
  });

  it('sends once however often the button is pressed while it is out', async () => {
    const answer = deferred();
    engagement.sendContactMessage.mockReturnValue(answer.promise);
    await open();
    const button = screen.getByRole('button', { name: 'Request a quote' });
    await fireEvent.press(button);
    await fireEvent.press(button);
    answer.resolve();
    await screen.findByText(/We’ve sent your flight request/);
    expect(engagement.sendContactMessage).toHaveBeenCalledTimes(1);
  });
});
