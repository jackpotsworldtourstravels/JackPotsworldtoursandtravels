import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { hotelApi, packageApi } from '@/api/endpoints/booking';
import { engagementApi } from '@/api/endpoints/engagement';
import { ApiError } from '@/api/errors';
import DeleteAccountScreen from '@/app/account/delete';
import { readDeletionRequest, recordDeletionRequest } from '@/features/account/localRequests';

import { ticket } from '../fixtures/account';
import { hotelBooking } from '../fixtures/booking';
import { accountApi, resetAccountApi } from '../helpers/accountMock';
import { authState, deferred, renderWithClient, resetNavigation, router, signInAsGuest, signOut } from '../helpers/mocks';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);
jest.mock('@/api/endpoints/account', () => require('../helpers/accountMock').accountApiModule);
jest.mock('@/api/endpoints/booking', () => ({ hotelApi: { list: jest.fn() }, packageApi: { list: jest.fn() } }));
jest.mock('@/api/endpoints/engagement', () => ({ engagementApi: { subscribeNewsletter: jest.fn(), sendContactMessage: jest.fn() } }));

const hotel = hotelApi as jest.Mocked<typeof hotelApi>;
const pkg = packageApi as jest.Mocked<typeof packageApi>;
const engagement = engagementApi as jest.Mocked<typeof engagementApi>;
const send = () => fireEvent.press(screen.getByRole('button', { name: 'Send deletion request' }));
const tick = () => fireEvent.press(screen.getByRole('checkbox', { name: /I understand this is a request/ }));
const emailed = () => engagement.sendContactMessage.mock.calls[0][0] as { name: string; email: string; subject: string; message: string };

beforeEach(() => {
  resetAccountApi();
  hotel.list.mockReset().mockResolvedValue([]);
  pkg.list.mockReset().mockResolvedValue([]);
  engagement.sendContactMessage.mockReset().mockResolvedValue(undefined);
  resetNavigation({}, { pathname: '/account/delete', segments: ['account', 'delete'] });
});

describe('what the customer is told before anything is sent', () => {
  it('says it is a request, sent by email, that does not delete the account straight away, and that the account keeps working', async () => {
    await renderWithClient(<DeleteAccountScreen />);
    expect(await screen.findByText(/This sends a request to our team by email/)).toBeOnTheScreen();
    expect(screen.getByText(/It does NOT delete your account straight away/)).toBeOnTheScreen();
    expect(screen.getByText(/keeps working, until our team has completed the request/)).toBeOnTheScreen();
    expect(screen.getByText(/aim to reply within 30 days/)).toBeOnTheScreen();
  });

  it('separates what we can delete from the records the law makes us keep', async () => {
    await renderWithClient(<DeleteAccountScreen />);
    expect(await screen.findByRole('header', { name: 'What we can delete' })).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'What we must keep' })).toBeOnTheScreen(); // headings, so a screen reader can jump to them
    expect(screen.getByText(/at least eight financial years/)).toBeOnTheScreen();
    expect(screen.getByText(/Signing out does not delete anything/)).toBeOnTheScreen();
  });

  it('does not claim the app verifies who the customer is, or that deletion is automatic', async () => {
    await renderWithClient(<DeleteAccountScreen />);
    await screen.findByText('What we can delete');
    expect(screen.queryByText(/automatic/i)).toBeNull();
    expect(screen.queryByText(/instantly|immediately/i)).toBeNull();
    expect(screen.getByText(/will check who you are before acting/)).toBeOnTheScreen();
  });
});

describe('sending the request', () => {
  it('will not send until the customer has ticked that they understand', async () => {
    await renderWithClient(<DeleteAccountScreen />);
    await screen.findByText('What we can delete');
    await send();
    expect(await screen.findByText('Tick the box to confirm you understand.')).toBeOnTheScreen();
    expect(engagement.sendContactMessage).not.toHaveBeenCalled();
  });

  it('announces whether the box is ticked, as a state a screen reader (and the web) can read', async () => {
    await renderWithClient(<DeleteAccountScreen />);
    await screen.findByText('What we can delete');
    expect(screen.getByRole('checkbox', { name: /I understand this is a request/ })).not.toBeChecked();
    await tick();
    expect(screen.getByRole('checkbox', { name: /I understand this is a request/ })).toBeChecked();
    await tick();
    expect(screen.getByRole('checkbox', { name: /I understand this is a request/ })).not.toBeChecked(); // and it can be un-ticked
  });

  it('emails ONE request with the fixed subject, then says the account is NOT deleted yet', async () => {
    await renderWithClient(<DeleteAccountScreen />);
    await screen.findByText('What we can delete');
    await fireEvent.changeText(screen.getByLabelText('Reason (optional)'), 'Moving abroad');
    await tick();
    await send();

    await waitFor(() => expect(engagement.sendContactMessage).toHaveBeenCalledTimes(1));
    const request = emailed();
    expect(request.subject).toBe('Account deletion request');
    expect(request.name).toBe('Asha Rao');
    expect(request.email).toBe('asha@example.com');
    expect(request.message).toContain('CUS-000001 (registered account)');
    expect(request.message).toContain('Reason: Moving abroad');
    expect(request.message).toContain('does not delete my account straight away');
    expect(request.message).toContain('Identity has NOT been verified by the app');
    // It is an email, not a ticket.
    expect(accountApi.supportApi.create).not.toHaveBeenCalled();

    expect(await screen.findByText(/Your account has NOT been deleted yet/)).toBeOnTheScreen();
    expect(screen.getByText(/reply to asha@example\.com/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Back to Help and support' }));
    expect(router.replace).toHaveBeenCalledWith('/support');
    // The phone remembers it, since an email cannot be looked up afterwards.
    expect(await readDeletionRequest('CUS-000001')).not.toBeNull();
  });

  it('sends only once however often Send is pressed while it is out', async () => {
    const answer = deferred();
    engagement.sendContactMessage.mockReturnValue(answer.promise);
    await renderWithClient(<DeleteAccountScreen />);
    await screen.findByText('What we can delete');
    await tick();
    await send();
    await send();
    await waitFor(() => expect(engagement.sendContactMessage).toHaveBeenCalledTimes(1));
    answer.resolve();
    expect(await screen.findByText(/Your account has NOT been deleted yet/)).toBeOnTheScreen();
    expect(engagement.sendContactMessage).toHaveBeenCalledTimes(1);
  });

  it('when the team cannot be reached, says so with the phone and email, never that it was sent, and remembers nothing', async () => {
    engagement.sendContactMessage.mockRejectedValue(new ApiError('server', { status: 503, message: 'We couldn’t send your message right now — email someone@example.com.' }));
    await renderWithClient(<DeleteAccountScreen />);
    await screen.findByText('What we can delete');
    await tick();
    await send();
    expect(await screen.findByText(/couldn’t send your request just now/)).toBeOnTheScreen();
    expect(screen.getByText(/\+91 91778 47799 or email support@jackpotsworldtours\.com/)).toBeOnTheScreen();
    expect(screen.queryByText(/someone@example\.com/)).toBeNull(); // the server's own text never reaches the screen
    expect(screen.queryByText(/has NOT been deleted yet/)).toBeNull();
    expect(await readDeletionRequest('CUS-000001')).toBeNull();
  });

  it('after a lost answer, says it may have arrived, does not claim it did, and sends again only if asked', async () => {
    engagement.sendContactMessage.mockRejectedValueOnce(new ApiError('timeout')).mockResolvedValueOnce(undefined);
    await renderWithClient(<DeleteAccountScreen />);
    await screen.findByText('What we can delete');
    await tick();
    await send();
    expect(await screen.findByText(/couldn’t confirm that your request reached us/)).toBeOnTheScreen();
    expect(screen.queryByText(/has NOT been deleted yet/)).toBeNull();
    expect(engagement.sendContactMessage).toHaveBeenCalledTimes(1); // nothing was resent behind their back
    expect(await readDeletionRequest('CUS-000001')).toBeNull();

    await send();
    expect(await screen.findByText(/Your account has NOT been deleted yet/)).toBeOnTheScreen();
    expect(engagement.sendContactMessage).toHaveBeenCalledTimes(2);
  });
});

describe('open bookings', () => {
  it('warns about them, names them, and still lets the customer send the request', async () => {
    hotel.list.mockResolvedValue([hotelBooking({ booking_ref: 'JPH000123' })]);
    await renderWithClient(<DeleteAccountScreen />);

    expect(await screen.findByText(/You have 1 open booking \(JPH000123\)/)).toBeOnTheScreen();
    expect(screen.getByText(/can’t complete your request until then. You can still send it now/)).toBeOnTheScreen();
    await tick();
    await send();
    await waitFor(() => expect(engagement.sendContactMessage).toHaveBeenCalledTimes(1));
    expect(emailed().message).toContain('Open bookings: JPH000123');
  });

  it('says nothing about bookings when there are none', async () => {
    await renderWithClient(<DeleteAccountScreen />);
    await screen.findByText('What we can delete');
    expect(screen.queryByText(/open booking/)).toBeNull();
  });

  it('says it could not check, and still lets the customer send, when bookings cannot be loaded', async () => {
    hotel.list.mockRejectedValue(new ApiError('network'));
    await renderWithClient(<DeleteAccountScreen />);
    expect(await screen.findByText(/couldn’t check your bookings just now/)).toBeOnTheScreen();
    await tick();
    await send();
    await waitFor(() => expect(engagement.sendContactMessage).toHaveBeenCalledTimes(1));
  });
});

describe('a request already sent', () => {
  it('an earlier request made as a ticket is still shown instead of the form, with a way to open it', async () => {
    accountApi.supportApi.list.mockResolvedValue([ticket({ id: 70, subject: 'Account deletion request' })]);
    await renderWithClient(<DeleteAccountScreen />);

    expect(await screen.findByText('You’ve already asked us to delete your account')).toBeOnTheScreen();
    expect(screen.getByText(/Your account has not been deleted yet/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Send deletion request' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'View your request' }));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/support/[id]', params: { id: '70' } });
  });

  it('allows a new request once the earlier ticket is resolved', async () => {
    accountApi.supportApi.list.mockResolvedValue([ticket({ subject: 'Account deletion request', status: 'resolved' })]);
    await renderWithClient(<DeleteAccountScreen />);
    expect(await screen.findByRole('button', { name: 'Send deletion request' })).toBeOnTheScreen();
  });

  it('a request this phone sent by email is remembered: it is shown instead of the form, and a second is not offered', async () => {
    await recordDeletionRequest('CUS-000001', new Date('2026-10-22T10:00:00Z'));
    await renderWithClient(<DeleteAccountScreen />);

    expect(await screen.findByText('You’ve already asked us to delete your account')).toBeOnTheScreen();
    expect(screen.getByText(/We sent it to our team by email, and they reply by email. Your account has not been deleted yet\./)).toBeOnTheScreen();
    expect(screen.getByText(/call \+91 91778 47799 or write to support@jackpotsworldtours\.com/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Send deletion request' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Send our team a message' }));
    expect(router.push).toHaveBeenCalledWith('/support/new');
    expect(engagement.sendContactMessage).not.toHaveBeenCalled();
  });

  it('is remembered per account: another account on the same phone still sees the form', async () => {
    await recordDeletionRequest('CUS-000999');
    await renderWithClient(<DeleteAccountScreen />);
    expect(await screen.findByRole('button', { name: 'Send deletion request' })).toBeOnTheScreen();
  });
});

describe('a guest', () => {
  beforeEach(() => signInAsGuest());

  it('must give an email address, because there is none on the account and the team replies by email', async () => {
    await renderWithClient(<DeleteAccountScreen />);
    expect(await screen.findByText(/we have no email address for you/)).toBeOnTheScreen();
    await tick();
    await send();
    expect(await screen.findByText('Give an email address we can reply to.')).toBeOnTheScreen();
    expect(engagement.sendContactMessage).not.toHaveBeenCalled();
  });

  it('is not allowed to give only a mobile number, which an email cannot be answered on', async () => {
    await renderWithClient(<DeleteAccountScreen />);
    await screen.findByText('What we can delete');
    await fireEvent.changeText(screen.getByLabelText('Email address we can reply to'), '+919876543210');
    await tick();
    await send();
    expect(await screen.findByText('Give an email address we can reply to.')).toBeOnTheScreen();
    expect(engagement.sendContactMessage).not.toHaveBeenCalled();
  });

  it('sends the request from that address, marked as a guest session', async () => {
    await renderWithClient(<DeleteAccountScreen />);
    await screen.findByText('What we can delete');
    await fireEvent.changeText(screen.getByLabelText('Email address we can reply to'), 'guest@example.com');
    await tick();
    await send();
    await waitFor(() => expect(engagement.sendContactMessage).toHaveBeenCalledTimes(1));
    expect(emailed().name).toBe('Guest');
    expect(emailed().email).toBe('guest@example.com');
    expect(emailed().message).toContain('guest session, no registered account');
    expect(emailed().message).toContain('Contact for this request: guest@example.com (email)');
    expect(emailed().message).toContain('from a guest session in the app');
  });
});

describe('a registered customer with no email on the account', () => {
  it('has to give one, like a guest, because the reply goes by email', async () => {
    authState.current = { ...authState.current, customer: { ...authState.current.customer!, email: null } };
    await renderWithClient(<DeleteAccountScreen />);
    await screen.findByText('What we can delete');
    await tick();
    await send();
    expect(await screen.findByText('Give an email address we can reply to.')).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText('Email address we can reply to'), 'asha.new@example.com');
    await send();
    await waitFor(() => expect(engagement.sendContactMessage).toHaveBeenCalledTimes(1));
    expect(emailed().email).toBe('asha.new@example.com');
  });
});

describe('a signed-out visitor', () => {
  it('is asked to sign in, and nothing is requested', async () => {
    signOut();
    await renderWithClient(<DeleteAccountScreen />);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(accountApi.supportApi.list).not.toHaveBeenCalled();
    expect(engagement.sendContactMessage).not.toHaveBeenCalled();
  });
});
