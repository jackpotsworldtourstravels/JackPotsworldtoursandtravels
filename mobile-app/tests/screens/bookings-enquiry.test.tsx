import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { hotelApi, packageApi } from '@/api/endpoints/booking';
import { ApiError } from '@/api/errors';
import BookingsScreen from '@/app/(tabs)/bookings';
import EnquireScreen from '@/app/packages/enquire';

import { hotelBooking, packageBooking, payment } from '../fixtures/booking';
import { deferred, renderWithClient, resetNavigation, router, signOut } from '../helpers/mocks';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);
jest.mock('@/api/endpoints/booking', () => ({
  hotelApi: { list: jest.fn() },
  packageApi: { list: jest.fn(), enquire: jest.fn() },
}));

const hotel = hotelApi as jest.Mocked<typeof hotelApi>;
const pkg = packageApi as jest.Mocked<typeof packageApi>;

describe('My bookings', () => {
  beforeEach(() => {
    hotel.list.mockReset().mockResolvedValue([hotelBooking({ created_at: '2026-10-20T10:00:00Z' })]);
    pkg.list.mockReset().mockResolvedValue([packageBooking({ created_at: '2026-10-21T10:00:00Z', status: 'confirmed', payments: [payment('captured')] })]);
    resetNavigation();
  });

  it('lists hotel and package bookings in groups, the one needing payment first, each with its honest status', async () => {
    await renderWithClient(<BookingsScreen />);

    expect(await screen.findByText('2 bookings')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Awaiting payment' })).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Upcoming' })).toBeOnTheScreen();
    expect(screen.queryByRole('header', { name: 'Past' })).toBeNull(); // empty groups are not shown
    const rows = screen.getAllByRole('button', { name: /JP[HP]\d+/ });
    expect(rows[0].props.accessibilityLabel).toMatch(/JPH000123.*Awaiting payment.*₹42,000/); // has something to do
    expect(rows[1].props.accessibilityLabel).toMatch(/JPP000045.*Confirmed.*₹64,890/);
  });

  it('puts cancelled bookings under Cancelled, and finished trips under Past', async () => {
    hotel.list.mockResolvedValue([hotelBooking({ status: 'cancelled', payments: [] })]);
    pkg.list.mockResolvedValue([packageBooking({ status: 'completed', payments: [payment('captured')] })]);
    await renderWithClient(<BookingsScreen />);

    expect(await screen.findByRole('header', { name: 'Past' })).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Cancelled' })).toBeOnTheScreen();
    expect(screen.queryByRole('header', { name: 'Upcoming' })).toBeNull();
    expect(screen.queryByRole('header', { name: 'Awaiting payment' })).toBeNull();
  });

  it('opens a booking’s own page, where it can be paid or checked, by reference only', async () => {
    await renderWithClient(<BookingsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /JPH000123/ }));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/booking/[ref]', params: { ref: 'JPH000123' } });
  });

  it('never shows a booking as confirmed just because the status says so without a captured payment', async () => {
    hotel.list.mockResolvedValue([hotelBooking({ status: 'confirmed', payments: [] })]);
    pkg.list.mockResolvedValue([]);
    await renderWithClient(<BookingsScreen />);
    const row = await screen.findByRole('button', { name: /JPH000123/ });
    expect(row.props.accessibilityLabel).not.toMatch(/Confirmed/);
  });

  it('says plainly when there are none, and points to where to start', async () => {
    hotel.list.mockResolvedValue([]);
    pkg.list.mockResolvedValue([]);
    await renderWithClient(<BookingsScreen />);
    expect(await screen.findByText('No bookings yet')).toBeOnTheScreen();
    // The footer band's "Explore destinations" comes after the empty state's own button.
    await fireEvent.press(screen.getAllByRole('button', { name: 'Explore destinations' })[0]);
    expect(router.push).toHaveBeenCalledWith('/explore');
  });

  it('asks a signed-out visitor to sign in and fetches nothing', async () => {
    signOut();
    await renderWithClient(<BookingsScreen />);
    expect(await screen.findByText('Your bookings')).toBeOnTheScreen();
    expect(hotel.list).not.toHaveBeenCalled();
    expect(pkg.list).not.toHaveBeenCalled();
  });

  it('shows an error with a retry if either list cannot be loaded', async () => {
    hotel.list.mockRejectedValueOnce(new ApiError('network'));
    await renderWithClient(<BookingsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('2 bookings')).toBeOnTheScreen();
  });
});

describe('Enquire about dates', () => {
  beforeEach(() => {
    pkg.enquire.mockReset().mockResolvedValue({ success: true, message: 'Please wait, our team will contact you soon.', enquiry_reference: 'TPE-000042' });
    resetNavigation({ packageId: '7', packageName: 'Goa Beach Escape' });
  });

  async function fillMessage(text = 'We would like to travel in December.') {
    await fireEvent.changeText(screen.getByLabelText('Your message'), text);
  }

  it('is pre-filled for a signed-in customer and says it is an enquiry, not a booking', async () => {
    await renderWithClient(<EnquireScreen />);
    expect(screen.getByDisplayValue('Asha Rao')).toBeOnTheScreen();
    expect(screen.getByDisplayValue('asha@example.com')).toBeOnTheScreen();
    expect(screen.getByText('Goa Beach Escape')).toBeOnTheScreen();
    expect(screen.getByText(/doesn’t book anything or take any payment/)).toBeOnTheScreen();
  });

  it('needs a message, and sends nothing until the form is right', async () => {
    await renderWithClient(<EnquireScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Send enquiry' }));
    expect(await screen.findByText('Tell us when you’d like to travel and anything we should know.')).toBeOnTheScreen();
    expect(pkg.enquire).not.toHaveBeenCalled();
  });

  it('sends the package, the person and the message, then shows the reference instead of the form', async () => {
    await renderWithClient(<EnquireScreen />);
    await fillMessage();
    await fireEvent.press(screen.getByRole('button', { name: 'Send enquiry' }));

    await waitFor(() => expect(pkg.enquire).toHaveBeenCalledTimes(1));
    expect(pkg.enquire.mock.calls[0][0]).toMatchObject({
      name: 'Asha Rao',
      email: 'asha@example.com',
      mobile: '+919876543210',
      package_id: 7,
      package_name: 'Goa Beach Escape',
      number_of_travellers: 2,
      message: 'We would like to travel in December.',
    });
    expect(await screen.findByText('TPE-000042')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Send enquiry' })).toBeNull(); // cannot be sent twice
  });

  it('sends once however many times it is pressed while it is going', async () => {
    const gate = deferred<{ success: boolean; message: string; enquiry_reference: string }>();
    pkg.enquire.mockReset().mockImplementation(() => gate.promise);
    await renderWithClient(<EnquireScreen />);
    await fillMessage();

    await fireEvent.press(screen.getByRole('button', { name: 'Send enquiry' }));
    await waitFor(() => expect(pkg.enquire).toHaveBeenCalledTimes(1));
    await fireEvent.press(screen.getByRole('button', { name: 'Send enquiry' }));
    gate.resolve({ success: true, message: 'ok', enquiry_reference: 'TPE-000043' });

    expect(await screen.findByText('TPE-000043')).toBeOnTheScreen();
    expect(pkg.enquire).toHaveBeenCalledTimes(1);
  });

  it('does not invite a duplicate when the answer was lost', async () => {
    pkg.enquire.mockReset().mockRejectedValue(new ApiError('timeout'));
    await renderWithClient(<EnquireScreen />);
    await fillMessage();
    await fireEvent.press(screen.getByRole('button', { name: 'Send enquiry' }));
    expect(await screen.findByText(/couldn’t confirm that your enquiry was sent/)).toBeOnTheScreen();
    expect(screen.queryByText(/TPE-/)).toBeNull(); // no false "sent" screen
    expect(screen.getByRole('button', { name: 'Send enquiry' })).toBeOnTheScreen();
  });

  it('shows the server’s sentence for a refusal', async () => {
    pkg.enquire.mockReset().mockRejectedValue(new ApiError('rate_limited', { status: 429 }));
    await renderWithClient(<EnquireScreen />);
    await fillMessage();
    await fireEvent.press(screen.getByRole('button', { name: 'Send enquiry' }));
    expect(await screen.findByText(/Too many attempts/)).toBeOnTheScreen();
  });
});
