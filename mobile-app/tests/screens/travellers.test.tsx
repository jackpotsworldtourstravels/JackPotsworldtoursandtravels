import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { ApiError } from '@/api/errors';
import EditTravellerScreen from '@/app/travellers/edit';
import TravellersScreen from '@/app/travellers/index';
import SessionsScreen from '@/app/account/sessions';

import { savedTraveller } from '../fixtures/account';
import { accountApi, resetAccountApi } from '../helpers/accountMock';
import { deferred, renderWithClient, resetNavigation, router, signOut } from '../helpers/mocks';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);
jest.mock('@/api/endpoints/account', () => require('../helpers/accountMock').accountApiModule);

const meera = savedTraveller();
const ravi = savedTraveller({ customer_traveller_id: 32, first_name: 'Ravi', last_name: 'Rao', traveller_type: 'child', passport_number: null, passport_expiry: null });

beforeEach(() => {
  resetAccountApi();
  resetNavigation({}, { pathname: '/travellers', segments: ['travellers'] });
});

describe('saved travellers', () => {
  it('lists them with only a hint of the passport, never the whole number', async () => {
    accountApi.travellerApi.list.mockResolvedValue([meera, ravi]);
    await renderWithClient(<TravellersScreen />);

    expect(await screen.findByText('Meera Nair')).toBeOnTheScreen();
    expect(screen.getByText(/Adult · Passport ending 567 · expires 1 Sep 2034/)).toBeOnTheScreen();
    expect(screen.getByText('Child')).toBeOnTheScreen(); // no passport saved: nothing to hint at
    expect(screen.queryByText(/N1234567/)).toBeNull();
  });

  it('explains what they are for when there are none, and offers to add one', async () => {
    await renderWithClient(<TravellersScreen />);
    expect(await screen.findByText('No saved travellers')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Add a traveller' }));
    expect(router.push).toHaveBeenCalledWith('/travellers/edit');
  });

  it('opens a traveller for editing by id', async () => {
    accountApi.travellerApi.list.mockResolvedValue([meera]);
    await renderWithClient(<TravellersScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Edit Meera Nair' }));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/travellers/edit', params: { id: '31' } });
  });

  it('asks before removing, then removes through the server', async () => {
    accountApi.travellerApi.list.mockResolvedValueOnce([meera, ravi]).mockResolvedValue([ravi]);
    await renderWithClient(<TravellersScreen />);

    await fireEvent.press(await screen.findByRole('button', { name: 'Remove Meera Nair' }));
    expect(screen.getByText(/doesn’t affect any booking you’ve made/)).toBeOnTheScreen();
    expect(accountApi.travellerApi.remove).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('button', { name: 'Yes, remove' }));
    await waitFor(() => expect(accountApi.travellerApi.remove).toHaveBeenCalledWith(31));
    await waitFor(() => expect(screen.queryByText('Meera Nair')).toBeNull());
    expect(screen.getByText('Ravi Rao')).toBeOnTheScreen();
  });

  it('removes only once if the confirm button is pressed again while the request is out', async () => {
    const gate = deferred<void>();
    accountApi.travellerApi.list.mockResolvedValue([meera]);
    accountApi.travellerApi.remove.mockImplementation(() => gate.promise);
    await renderWithClient(<TravellersScreen />);

    await fireEvent.press(await screen.findByRole('button', { name: 'Remove Meera Nair' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Yes, remove' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Yes, remove' }));
    await waitFor(() => expect(accountApi.travellerApi.remove).toHaveBeenCalledTimes(1));
    gate.resolve();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Yes, remove' })).toBeEnabled());
    expect(accountApi.travellerApi.remove).toHaveBeenCalledTimes(1);
  });

  it('can be backed out of without removing anyone', async () => {
    accountApi.travellerApi.list.mockResolvedValue([meera]);
    await renderWithClient(<TravellersScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Remove Meera Nair' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.getByRole('button', { name: 'Edit Meera Nair' })).toBeOnTheScreen();
    expect(accountApi.travellerApi.remove).not.toHaveBeenCalled();
  });

  it('shows the server’s sentence if removal is refused', async () => {
    accountApi.travellerApi.list.mockResolvedValue([meera]);
    accountApi.travellerApi.remove.mockRejectedValue(new ApiError('not_found', { status: 404, message: 'Traveller not found.' }));
    await renderWithClient(<TravellersScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Remove Meera Nair' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Yes, remove' }));
    expect(await screen.findByText('Traveller not found.')).toBeOnTheScreen();
  });

  it('asks a signed-out visitor to sign in', async () => {
    signOut();
    await renderWithClient(<TravellersScreen />);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(accountApi.travellerApi.list).not.toHaveBeenCalled();
  });
});

describe('adding a traveller', () => {
  it('saves a person with just a name', async () => {
    accountApi.travellerApi.create.mockResolvedValue(meera);
    await renderWithClient(<EditTravellerScreen />);

    await fireEvent.changeText(screen.getByLabelText('First name'), 'Meera');
    await fireEvent.changeText(screen.getByLabelText('Last name'), 'Nair');
    await fireEvent.press(screen.getByRole('button', { name: 'Save traveller' }));

    await waitFor(() => expect(accountApi.travellerApi.create).toHaveBeenCalledTimes(1));
    expect(accountApi.travellerApi.create).toHaveBeenCalledWith({
      traveller_type: 'adult',
      first_name: 'Meera',
      last_name: 'Nair',
      date_of_birth: null,
      nationality: null,
      passport_number: null,
      passport_expiry: null,
      issuing_country: null,
    });
    await waitFor(() => expect(router.back).toHaveBeenCalled());
  });

  it('saves a child with a passport, tidied (no spaces, capitals)', async () => {
    accountApi.travellerApi.create.mockResolvedValue(ravi);
    await renderWithClient(<EditTravellerScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Child' }));
    await fireEvent.changeText(screen.getByLabelText('First name'), 'Ravi');
    await fireEvent.changeText(screen.getByLabelText('Last name'), 'Rao');
    await fireEvent.changeText(screen.getByLabelText('Passport number'), 'p 7654 321');
    await fireEvent.changeText(screen.getByLabelText('Passport expiry (YYYY-MM-DD)'), '2033-05-30');
    await fireEvent.press(screen.getByRole('button', { name: 'Save traveller' }));

    await waitFor(() => expect(accountApi.travellerApi.create).toHaveBeenCalledTimes(1));
    expect(accountApi.travellerApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ traveller_type: 'child', passport_number: 'P7654321', passport_expiry: '2033-05-30' }),
    );
  });

  it('will not save without a name, or a passport number without its expiry', async () => {
    await renderWithClient(<EditTravellerScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Save traveller' }));
    expect(await screen.findByText('First name is required.')).toBeOnTheScreen();
    expect(screen.getByText('Last name is required.')).toBeOnTheScreen();

    await fireEvent.changeText(screen.getByLabelText('First name'), 'Meera');
    await fireEvent.changeText(screen.getByLabelText('Last name'), 'Nair');
    await fireEvent.changeText(screen.getByLabelText('Passport number'), 'N1234567');
    await fireEvent.press(screen.getByRole('button', { name: 'Save traveller' }));
    expect(await screen.findByText('Add the passport’s expiry date.')).toBeOnTheScreen();
    expect(accountApi.travellerApi.create).not.toHaveBeenCalled();
  });

  it('tells the customer, without inviting a duplicate, when it cannot tell whether the save arrived', async () => {
    accountApi.travellerApi.create.mockRejectedValue(new ApiError('timeout'));
    await renderWithClient(<EditTravellerScreen />);
    await fireEvent.changeText(screen.getByLabelText('First name'), 'Meera');
    await fireEvent.changeText(screen.getByLabelText('Last name'), 'Nair');
    await fireEvent.press(screen.getByRole('button', { name: 'Save traveller' }));

    expect(await screen.findByText(/couldn’t confirm this was saved. Check your saved travellers/)).toBeOnTheScreen();
    expect(router.back).not.toHaveBeenCalled();
  });
});

describe('editing a traveller', () => {
  beforeEach(() => {
    resetNavigation({ id: '31' }, { pathname: '/travellers/edit', segments: ['travellers', 'edit'] });
    accountApi.travellerApi.list.mockResolvedValue([meera, ravi]);
  });

  it('opens with what is saved, and saves a change to THAT traveller', async () => {
    accountApi.travellerApi.update.mockResolvedValue(meera);
    await renderWithClient(<EditTravellerScreen />);

    await waitFor(() => expect(screen.getByLabelText('First name').props.value).toBe('Meera'));
    expect(screen.getByLabelText('Passport number').props.value).toBe('N1234567');
    await fireEvent.changeText(screen.getByLabelText('Nationality'), 'British');
    await fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(accountApi.travellerApi.update).toHaveBeenCalledTimes(1));
    expect(accountApi.travellerApi.update).toHaveBeenCalledWith(31, expect.objectContaining({ nationality: 'British', first_name: 'Meera' }));
    expect(accountApi.travellerApi.create).not.toHaveBeenCalled();
  });

  it('says so for an id that is not on this customer’s list, however it got there', async () => {
    resetNavigation({ id: '999' }, { pathname: '/travellers/edit', segments: ['travellers', 'edit'] });
    await renderWithClient(<EditTravellerScreen />);
    expect(await screen.findByText('We couldn’t find that traveller')).toBeOnTheScreen();
    expect(screen.queryByLabelText('First name')).toBeNull();
  });

  it('refuses an id that is not a number', async () => {
    resetNavigation({ id: 'abc' }, { pathname: '/travellers/edit', segments: ['travellers', 'edit'] });
    await renderWithClient(<EditTravellerScreen />);
    expect(await screen.findByText('We couldn’t find that traveller')).toBeOnTheScreen();
    expect(accountApi.travellerApi.list).not.toHaveBeenCalled();
  });
});

describe('where you’re signed in', () => {
  it('lists the sessions the server reports, and says signing out ends them all', async () => {
    accountApi.profileApi.sessions.mockResolvedValue([
      { id: 1, browser: 'Chrome', device: 'Windows', login_at: '2026-10-20T09:00:00Z', last_seen_at: '2026-10-21T08:30:00Z' },
      { id: 2, browser: null, device: null, login_at: '2026-10-19T09:00:00Z', last_seen_at: '2026-10-19T09:10:00Z' },
    ]);
    await renderWithClient(<SessionsScreen />);

    expect(await screen.findByText('Chrome on Windows')).toBeOnTheScreen();
    expect(screen.getByText('A device')).toBeOnTheScreen();
    expect(screen.getByText(/Signing out on this phone signs you out everywhere/)).toBeOnTheScreen();
    expect(screen.queryByText(/\d+\.\d+\.\d+\.\d+/)).toBeNull(); // never an IP address
  });

  it('offers a retry when the sessions cannot be loaded', async () => {
    accountApi.profileApi.sessions.mockRejectedValueOnce(new ApiError('network')).mockResolvedValue([]);
    await renderWithClient(<SessionsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByText('No other sessions')).toBeOnTheScreen();
  });
});
