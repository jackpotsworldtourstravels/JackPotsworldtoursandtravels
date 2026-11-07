import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { enquiriesApi } from '@/api/endpoints/enquiries';
import { ApiError } from '@/api/errors';
import GamingScreen from '@/app/gaming/index';
import { GAMING_COPY } from '@/features/gaming/gamingForm';
import { addDays, todayISO } from '@/utils/dates';

import { deferred, renderWithClient, resetNavigation, router, signOut } from '../helpers/mocks';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);
jest.mock('@/api/endpoints/enquiries', () => ({ enquiriesApi: { submitGaming: jest.fn() } }));

const enquiries = enquiriesApi as jest.Mocked<typeof enquiriesApi>;
const submit = () => fireEvent.press(screen.getByRole('button', { name: GAMING_COPY.submit }));

async function chooseDate() {
  const later = addDays(todayISO(), 10);
  const day = Number(later.slice(8));
  const monthLabel = new Date(Number(later.slice(0, 4)), Number(later.slice(5, 7)) - 1, day).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  await fireEvent.press(screen.getByRole('button', { name: /^Travel Date:/ }));
  for (let i = 0; i < 2 && !screen.queryByText(monthLabel); i += 1) await fireEvent.press(screen.getByRole('button', { name: 'Next month' }));
  await fireEvent.press(screen.getByRole('button', { name: new RegExp(`^\\w+ ${day} ${monthLabel}`) }));
  return later;
}

async function fillTrip() {
  await fireEvent.changeText(screen.getByLabelText('From Airport *'), 'Hyderabad (HYD)');
  await fireEvent.changeText(screen.getByLabelText('To Airport *'), 'Bangkok (BKK)');
  const date = await chooseDate();
  await fireEvent.changeText(screen.getByLabelText('Number of Nights *'), '4');
  await fireEvent.changeText(screen.getByLabelText('Casino Type *'), 'Poker rooms');
  return date;
}

beforeEach(() => {
  enquiries.submitGaming.mockReset().mockResolvedValue({ enquiry_reference: 'GTE-000123' });
  resetNavigation({}, { pathname: '/gaming', segments: ['gaming'] });
});

describe('the Gaming Tour Packages screen', () => {
  it('shows the website’s heading, sections and fields', async () => {
    await renderWithClient(<GamingScreen />);
    expect(screen.getByText(GAMING_COPY.title)).toBeOnTheScreen();
    // The site sets its section headings in tracked capitals.
    for (const t of [GAMING_COPY.customer.title, GAMING_COPY.travel.title, GAMING_COPY.preference.title]) expect(screen.getByText(t.toUpperCase())).toBeOnTheScreen();
    for (const label of ['Full Name *', 'Email Address *', 'Mobile Number *', 'From Airport *', 'To Airport *', 'Travel Time (24-hour, HH:MM) *', 'Number of Nights *', 'Casino Type *']) {
      expect(screen.getByLabelText(label)).toBeOnTheScreen();
    }
    expect(screen.getByRole('button', { name: /^Travel Date:/ })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: GAMING_COPY.submit })).toBeOnTheScreen();
  });

  it('starts with the signed-in customer’s details, and with nothing for a visitor', async () => {
    await renderWithClient(<GamingScreen />);
    expect(screen.getByLabelText('Full Name *').props.value).toBe('Asha Rao');
    expect(screen.getByLabelText('Email Address *').props.value).toBe('asha@example.com');
    expect(screen.getByLabelText('Mobile Number *').props.value).toBe('+919876543210');
  });

  it('a visitor starts empty', async () => {
    signOut();
    await renderWithClient(<GamingScreen />);
    expect(screen.getByLabelText('Full Name *').props.value).toBe('');
    expect(screen.getByLabelText('Email Address *').props.value).toBe('');
  });

  it('refuses an incomplete form with the website’s messages and sends nothing', async () => {
    signOut();
    await renderWithClient(<GamingScreen />);
    await submit();
    for (const m of [
      'Please enter your full name.',
      'Please enter your email address.',
      'Please enter your mobile number.',
      'Please enter a departure airport.',
      'Please enter an arrival airport.',
      'Please choose a travel date and time.',
      'Please enter the number of nights (1 or more).',
      'Please tell us your casino preference.',
    ]) {
      expect(await screen.findByText(m)).toBeOnTheScreen();
    }
    expect(enquiries.submitGaming).not.toHaveBeenCalled();
  });

  it('clears a field’s message as soon as it is edited', async () => {
    signOut();
    await renderWithClient(<GamingScreen />);
    await submit();
    expect(await screen.findByText('Please enter your full name.')).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText('Full Name *'), 'A');
    expect(screen.queryByText('Please enter your full name.')).toBeNull();
  });

  it('sends the enquiry and shows the reference and what happens next, with nothing charged', async () => {
    await renderWithClient(<GamingScreen />);
    const date = await fillTrip();
    await submit();

    await waitFor(() => expect(enquiries.submitGaming).toHaveBeenCalledTimes(1));
    expect(enquiries.submitGaming).toHaveBeenCalledWith({
      name: 'Asha Rao',
      email: 'asha@example.com',
      mobile: '+919876543210',
      from_airport: 'Hyderabad (HYD)',
      to_airport: 'Bangkok (BKK)',
      travel_datetime: `${date}T10:00:00+05:30`,
      number_of_nights: 4,
      casino_type: 'Poker rooms',
    });
    expect(await screen.findByText(/Enquiry received\. Please wait, our team will contact you soon\./)).toBeOnTheScreen();
    expect(screen.getByText('GTE-000123')).toBeOnTheScreen();
    expect(screen.getByText(GAMING_COPY.next.title)).toBeOnTheScreen();
    for (const item of GAMING_COPY.next.items) expect(screen.getByText(`• ${item}`)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: GAMING_COPY.submit })).toBeNull();

    await fireEvent.press(screen.getByText(GAMING_COPY.contact));
    expect(router.push).toHaveBeenCalledWith('/support');
  });

  it('sends once however often the button is pressed while it is out', async () => {
    const answer = deferred<{ enquiry_reference: string }>();
    enquiries.submitGaming.mockReturnValue(answer.promise);
    await renderWithClient(<GamingScreen />);
    await fillTrip();
    await submit();
    await submit();
    answer.resolve({ enquiry_reference: 'GTE-000124' });
    await screen.findByText('GTE-000124');
    expect(enquiries.submitGaming).toHaveBeenCalledTimes(1);
  });

  it('when the server refuses, says so and keeps what was typed', async () => {
    enquiries.submitGaming.mockRejectedValueOnce(new ApiError('server', { status: 500, message: 'boom' }));
    await renderWithClient(<GamingScreen />);
    await fillTrip();
    await submit();
    expect(await screen.findByText('We could not submit your enquiry. Please try again.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Casino Type *').props.value).toBe('Poker rooms');
    expect(screen.queryByText(/Enquiry received/)).toBeNull();
  });

  it('after a lost answer, says it cannot confirm and that there is no reference to check', async () => {
    enquiries.submitGaming.mockRejectedValueOnce(new ApiError('timeout'));
    await renderWithClient(<GamingScreen />);
    await fillTrip();
    await submit();
    expect(await screen.findByText(/couldn’t confirm that your enquiry reached us, and there is no reference to check/)).toBeOnTheScreen();
    expect(screen.queryByText(/Enquiry received/)).toBeNull();
    expect(enquiries.submitGaming).toHaveBeenCalledTimes(1);
  });

  it('offers a phone number for a customer who would rather talk', async () => {
    await renderWithClient(<GamingScreen />);
    expect(screen.getByRole('link', { name: /^Call \+91/ })).toBeOnTheScreen();
  });
});
