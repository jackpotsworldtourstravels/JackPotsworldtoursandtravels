import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

import { engagementApi } from '@/api/endpoints/engagement';
import { ApiError } from '@/api/errors';
import SupportScreen from '@/app/support/index';
import NewMessageScreen from '@/app/support/new';
import TicketScreen from '@/app/support/[id]';

import { ticket } from '../fixtures/account';
import { accountApi, resetAccountApi } from '../helpers/accountMock';
import { deferred, renderWithClient, resetNavigation, router, signInAsGuest, signOut } from '../helpers/mocks';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);
jest.mock('@/api/endpoints/account', () => require('../helpers/accountMock').accountApiModule);
jest.mock('@/api/endpoints/engagement', () => ({ engagementApi: { subscribeNewsletter: jest.fn(), sendContactMessage: jest.fn() } }));

const engagement = engagementApi as jest.Mocked<typeof engagementApi>;
let openURL: jest.SpyInstance;

beforeEach(() => {
  resetAccountApi();
  engagement.sendContactMessage.mockReset().mockResolvedValue(undefined);
  resetNavigation({}, { pathname: '/support', segments: ['support'] });
  openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});

afterEach(() => openURL.mockRestore());

describe('help and support', () => {
  it('gives the company’s own phone number and email, whoever is looking, even signed out', async () => {
    signOut();
    await renderWithClient(<SupportScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Call +91 91778 47799' }));
    expect(openURL).toHaveBeenCalledWith('tel:+919177847799');
    await fireEvent.press(screen.getByRole('button', { name: 'Email us' }));
    expect(openURL).toHaveBeenCalledWith('mailto:support@jackpotsworldtours.com');
  });

  it('carries the website’s contact facts: hours, address and how to visit', async () => {
    signOut();
    await renderWithClient(<SupportScreen />);
    expect(screen.getByText('Hours: 24 hours a day, 7 days a week')).toBeOnTheScreen();
    expect(screen.getByText(/Hyderabad, Telangana, India\. Visits are by appointment, so please call before travelling to see us\./)).toBeOnTheScreen();
  });

  it('says what to do instead, in words, on a device that cannot place a call', async () => {
    openURL.mockRejectedValue(new Error('no handler'));
    await renderWithClient(<SupportScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Call +91 91778 47799' }));
    expect(await screen.findByText('This device can’t place calls. Please call +91 91778 47799.')).toBeOnTheScreen();
  });

  it('lets anyone, signed in or not, send the team a message', async () => {
    signOut();
    await renderWithClient(<SupportScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Send us a message' }));
    expect(router.push).toHaveBeenCalledWith('/support/new');
  });

  it('shows nothing about earlier requests to a signed-out visitor, and fetches none', async () => {
    signOut();
    await renderWithClient(<SupportScreen />);
    expect(screen.queryByRole('header', { name: 'Earlier requests' })).toBeNull();
    expect(accountApi.supportApi.list).not.toHaveBeenCalled();
  });

  it('keeps earlier requests readable, with their status, and opens one', async () => {
    accountApi.supportApi.list.mockResolvedValue([ticket(), ticket({ id: 89, subject: 'Visa question', status: 'resolved' })]);
    await renderWithClient(<SupportScreen />);

    expect(await screen.findByRole('header', { name: 'Earlier requests' })).toBeOnTheScreen();
    expect(screen.getByText('These are requests you sent before. New messages go to our team by email.')).toBeOnTheScreen();
    expect(screen.getByText('Visa question')).toBeOnTheScreen();
    expect(screen.getByText(/Resolved · updated/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Visa question, Resolved' }));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/support/[id]', params: { id: '89' } });
  });

  it('no longer offers to create a ticket', async () => {
    accountApi.supportApi.list.mockResolvedValue([ticket()]);
    await renderWithClient(<SupportScreen />);
    await screen.findByRole('header', { name: 'Earlier requests' });
    expect(screen.queryByRole('button', { name: 'New request' })).toBeNull();
    expect(accountApi.supportApi.create).not.toHaveBeenCalled();
  });

  it('shows a guest the same earlier requests, and nothing at all when there are none', async () => {
    signInAsGuest();
    await renderWithClient(<SupportScreen />);
    await waitFor(() => expect(accountApi.supportApi.list).toHaveBeenCalled());
    expect(screen.queryByRole('header', { name: 'Earlier requests' })).toBeNull();
    expect(screen.queryByText('No requests yet')).toBeNull();
  });

  it('does not break the page when the earlier requests cannot be loaded', async () => {
    accountApi.supportApi.list.mockRejectedValue(new ApiError('network'));
    await renderWithClient(<SupportScreen />);
    await waitFor(() => expect(accountApi.supportApi.list).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Send us a message' })).toBeOnTheScreen();
    expect(screen.queryByRole('header', { name: 'Earlier requests' })).toBeNull();
  });
});

describe('sending a message', () => {
  const fill = async (over: { name?: string; email?: string; subject?: string; message?: string }) => {
    if (over.name !== undefined) await fireEvent.changeText(screen.getByLabelText('Your name'), over.name);
    if (over.email !== undefined) await fireEvent.changeText(screen.getByLabelText('Email we can reply to'), over.email);
    if (over.subject !== undefined) await fireEvent.changeText(screen.getByLabelText('Subject (optional)'), over.subject);
    if (over.message !== undefined) await fireEvent.changeText(screen.getByLabelText('Message'), over.message);
  };
  const send = () => fireEvent.press(screen.getByRole('button', { name: 'Send message' }));

  beforeEach(() => resetNavigation({}, { pathname: '/support/new', segments: ['support', 'new'] }));

  it('starts with the signed-in customer’s name and email, and sends the website’s contact payload', async () => {
    await renderWithClient(<NewMessageScreen />);
    expect(screen.getByLabelText('Your name').props.value).toBe('Asha Rao');
    expect(screen.getByLabelText('Email we can reply to').props.value).toBe('asha@example.com');

    await fill({ subject: '  Visa   question ', message: '  Do I need a visa for Dubai?  ' });
    await send();

    await waitFor(() => expect(engagement.sendContactMessage).toHaveBeenCalledTimes(1));
    expect(engagement.sendContactMessage).toHaveBeenCalledWith({
      name: 'Asha Rao',
      email: 'asha@example.com',
      subject: 'Visa question',
      message: 'Do I need a visa for Dubai?',
    });
    // It is an email now, not a ticket.
    expect(accountApi.supportApi.create).not.toHaveBeenCalled();
    expect(await screen.findByText('We’ve sent your message to our team. They will reply by email to asha@example.com.')).toBeOnTheScreen();
  });

  it('leaves an empty subject out of the request, as the website’s form does', async () => {
    await renderWithClient(<NewMessageScreen />);
    await fill({ message: 'Hello' });
    await send();
    await waitFor(() => expect(engagement.sendContactMessage).toHaveBeenCalled());
    expect(engagement.sendContactMessage.mock.calls[0][0]).not.toHaveProperty('subject');
  });

  it('needs no account: a signed-out visitor can send, and gives their own name and email', async () => {
    signOut();
    await renderWithClient(<NewMessageScreen />);
    expect(screen.getByLabelText('Your name').props.value).toBe('');
    await fill({ name: 'Ravi', email: 'ravi@example.com', message: 'Is the Goa package open?' });
    await send();
    await waitFor(() => expect(engagement.sendContactMessage).toHaveBeenCalledWith({ name: 'Ravi', email: 'ravi@example.com', message: 'Is the Goa package open?' }));
  });

  it('starts from a booking: its reference goes in the subject and is shown on the form', async () => {
    resetNavigation({ ref: 'JPH000123' }, { pathname: '/support/new', segments: ['support', 'new'] });
    await renderWithClient(<NewMessageScreen />);
    expect(screen.getByLabelText('Subject (optional)').props.value).toBe('Help with booking JPH000123');
    expect(screen.getByText('JPH000123')).toBeOnTheScreen();
  });

  it('ignores a reference that is not one, rather than putting arbitrary text in a subject line', async () => {
    resetNavigation({ ref: 'JPH000123; DROP TABLE' }, { pathname: '/support/new', segments: ['support', 'new'] });
    await renderWithClient(<NewMessageScreen />);
    expect(screen.getByLabelText('Subject (optional)').props.value).toBe('');
    expect(screen.queryByText('About booking')).toBeNull();
  });

  it('carries a subject from another screen', async () => {
    resetNavigation({ subject: 'About: Visa question' }, { pathname: '/support/new', segments: ['support', 'new'] });
    await renderWithClient(<NewMessageScreen />);
    expect(screen.getByLabelText('Subject (optional)').props.value).toBe('About: Visa question');
  });

  it('needs a name, a valid email and a message, and sends nothing until they are there', async () => {
    signOut();
    await renderWithClient(<NewMessageScreen />);
    await send();
    expect(await screen.findByText('Tell us your name.')).toBeOnTheScreen();
    expect(screen.getByText('Enter an email address we can reply to.')).toBeOnTheScreen();
    expect(screen.getByText('Tell us what you need.')).toBeOnTheScreen();
    await fill({ name: 'Ravi', email: 'not-an-email', message: 'Hi' });
    await send();
    expect(await screen.findByText('Enter an email address we can reply to.')).toBeOnTheScreen();
    expect(engagement.sendContactMessage).not.toHaveBeenCalled();
  });

  it('when the team cannot be reached, says so and gives the phone and email, never "sent"', async () => {
    engagement.sendContactMessage.mockRejectedValueOnce(new ApiError('server', { status: 503, message: 'We couldn’t send your message right now — please email us directly at someone@example.com instead.' }));
    await renderWithClient(<NewMessageScreen />);
    await fill({ message: 'Hello' });
    await send();
    expect(await screen.findByText(/couldn’t send that just now/)).toBeOnTheScreen();
    expect(screen.getByText(/\+91 91778 47799 or email support@jackpotsworldtours\.com/)).toBeOnTheScreen();
    // The server's own text, which can name an inbox, never reaches the screen.
    expect(screen.queryByText(/someone@example\.com/)).toBeNull();
    expect(screen.queryByText(/We’ve sent your message/)).toBeNull();

    await send();
    expect(await screen.findByText(/We’ve sent your message/)).toBeOnTheScreen();
  });

  it('after a lost answer, says it may or may not have arrived, and lets the customer decide', async () => {
    engagement.sendContactMessage.mockRejectedValueOnce(new ApiError('timeout'));
    await renderWithClient(<NewMessageScreen />);
    await fill({ message: 'Hello' });
    await send();
    expect(await screen.findByText(/couldn’t confirm that your message reached us/)).toBeOnTheScreen();
    expect(screen.queryByText(/We’ve sent your message/)).toBeNull();
    expect(engagement.sendContactMessage).toHaveBeenCalledTimes(1); // nothing was resent behind their back
  });

  it('sends once however often Send is pressed while the request is open', async () => {
    const open = deferred();
    engagement.sendContactMessage.mockReturnValue(open.promise);
    await renderWithClient(<NewMessageScreen />);
    await fill({ message: 'Hello' });
    await send();
    await send();
    await send();
    open.resolve();
    await screen.findByText(/We’ve sent your message/);
    expect(engagement.sendContactMessage).toHaveBeenCalledTimes(1);
  });
});

describe('an earlier request', () => {
  beforeEach(() => {
    resetNavigation({ id: '88' }, { pathname: '/support/88', segments: ['support', '[id]'] });
    accountApi.supportApi.get.mockResolvedValue(ticket());
  });

  it('shows the whole thread, who said what, and its status', async () => {
    await renderWithClient(<TicketScreen />);

    expect(await screen.findByRole('header', { name: 'Help with booking JPH000123' })).toBeOnTheScreen();
    expect(screen.getByText('Open')).toBeOnTheScreen();
    expect(screen.getByText('Can I change the check-in date?')).toBeOnTheScreen();
    expect(screen.getByText('Yes, which date would you like?')).toBeOnTheScreen();
    expect(screen.getByText(/^You · /)).toBeOnTheScreen();
    expect(screen.getByText(/^JackpotsWorld team · /)).toBeOnTheScreen();
    expect(accountApi.supportApi.get).toHaveBeenCalledWith(88);
  });

  it('is read-only: replies are no longer read here, so there is no reply box, and nothing is sent', async () => {
    await renderWithClient(<TicketScreen />);
    await screen.findByText('Can I change the check-in date?');
    expect(screen.queryByLabelText('Your reply')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send reply' })).toBeNull();
    expect(screen.getByText(/New messages go to our team by email, and replies to this one are no longer read here/)).toBeOnTheScreen();
    expect(accountApi.supportApi.reply).not.toHaveBeenCalled();
  });

  it('offers a new message about it, with the old subject carried over', async () => {
    await renderWithClient(<TicketScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Send a new message about this' }));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/support/new', params: { subject: 'About: Help with booking JPH000123' } });
  });

  it('says the same for a resolved or closed one', async () => {
    accountApi.supportApi.get.mockResolvedValue(ticket({ status: 'closed' }));
    await renderWithClient(<TicketScreen />);
    expect(await screen.findByRole('button', { name: 'Send a new message about this' })).toBeOnTheScreen();
    expect(screen.queryByLabelText('Your reply')).toBeNull();
  });

  it('says so for a request that is not on this account', async () => {
    accountApi.supportApi.get.mockRejectedValue(new ApiError('not_found', { status: 404, message: 'Ticket not found.' }));
    await renderWithClient(<TicketScreen />);
    expect(await screen.findByText('We couldn’t find that request')).toBeOnTheScreen();
  });

  it('refuses an id that is not a number without asking the server', async () => {
    resetNavigation({ id: 'abc' }, { pathname: '/support/abc', segments: ['support', '[id]'] });
    await renderWithClient(<TicketScreen />);
    expect(await screen.findByText('We couldn’t find that request')).toBeOnTheScreen();
    expect(accountApi.supportApi.get).not.toHaveBeenCalled();
  });
});
