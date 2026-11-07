import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import ProfileScreen from '@/app/(tabs)/profile';
import EditProfileScreen from '@/app/account/edit';
import { ApiError } from '@/api/errors';
import { returnTo } from '@/features/auth/returnTo';

import { accountApi, resetAccountApi } from '../helpers/accountMock';
import { authState, renderWithClient, resetNavigation, router, signInAsGuest, signOut } from '../helpers/mocks';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);
jest.mock('@/api/endpoints/account', () => require('../helpers/accountMock').accountApiModule);
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));

beforeEach(() => {
  resetAccountApi();
  returnTo.clear();
  resetNavigation({}, { pathname: '/profile', segments: ['(tabs)', 'profile'] });
});

describe('the profile tab for a customer with an account', () => {
  it('shows who they are, with what is and is not verified, and leaves out what is blank', async () => {
    await renderWithClient(<ProfileScreen />);

    expect(screen.getByRole('header', { name: 'Asha Rao' })).toBeOnTheScreen();
    expect(screen.getByText('CUS-000001')).toBeOnTheScreen();
    expect(screen.getByText(/asha@example\.com/)).toBeOnTheScreen();
    expect(screen.getByText('Verified')).toBeOnTheScreen(); // the email is verified
    expect(screen.getByText(/\+919876543210/)).toBeOnTheScreen();
    expect(screen.getByText('Not verified')).toBeOnTheScreen(); // the mobile is not
    expect(screen.queryByText('Date of birth')).toBeNull();
    expect(screen.queryByText('Address')).toBeNull();
  });

  it('opens Edit details and each part of the account', async () => {
    await renderWithClient(<ProfileScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Edit details' }));
    expect(router.push).toHaveBeenLastCalledWith('/account/edit');
    const go = async (name: RegExp, path: string) => {
      await fireEvent.press(screen.getByRole('button', { name }));
      expect(router.push).toHaveBeenLastCalledWith(path);
    };
    await go(/^My bookings/, '/bookings');
    await go(/^Payments/, '/payments');
    await go(/^Wishlist/, '/wishlist');
    await go(/^Saved travellers/, '/travellers');
    await go(/^Help and support/, '/support');
    await go(/^Where you’re signed in/, '/account/sessions');
    await go(/^Delete my account/, '/account/delete');
  });

  it('signs out at once: an account can always sign back in', async () => {
    const { signOut: signOutFn } = authState.current;
    await renderWithClient(<ProfileScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(signOutFn).toHaveBeenCalledTimes(1));
  });
});

describe('the profile tab for a guest', () => {
  beforeEach(() => signInAsGuest());

  it('says they are browsing as a guest and offers to make an account, rather than showing details they do not have', async () => {
    await renderWithClient(<ProfileScreen />);

    expect(screen.getByRole('header', { name: 'Browsing as a guest' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Edit details' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Where you’re signed in/ })).toBeNull();
    expect(screen.queryByText(/CUS-/)).toBeNull();
    expect(screen.getByRole('button', { name: /^Delete my account/ })).toBeOnTheScreen(); // a guest can ask too
  });

  it('sends them to create an account or sign in, and brings them back to this tab afterwards', async () => {
    await renderWithClient(<ProfileScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Create account' }));
    expect(router.push).toHaveBeenLastCalledWith('/sign-up');
    expect(returnTo.take()).toMatchObject({ at: '/profile', tab: true }); // a tab, so it is switched back to

    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(router.push).toHaveBeenLastCalledWith('/sign-in');
  });

  it('asks before ending a guest session, because that strands their bookings and saved items', async () => {
    const { signOut: signOutFn } = authState.current;
    await renderWithClient(<ProfileScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'End guest session' }));
    expect(signOutFn).not.toHaveBeenCalled();
    expect(screen.getByText(/removes your way back to your bookings/)).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Keep my session' }));
    expect(signOutFn).not.toHaveBeenCalled();
    expect(screen.queryByText(/removes your way back/)).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'End guest session' }));
    await fireEvent.press(screen.getByRole('button', { name: 'End guest session' })); // the confirm button
    await waitFor(() => expect(signOutFn).toHaveBeenCalledTimes(1));
  });
});

describe('the profile tab signed out', () => {
  it('asks the visitor to sign in', async () => {
    signOut();
    await renderWithClient(<ProfileScreen />);
    expect(screen.getByText('Your profile')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Edit details' })).toBeNull();
  });
});

describe('Edit details', () => {
  const field = (label: string) => screen.getByLabelText(label);
  const saved = (over = {}) => ({ ...authState.current.customer!, ...over });

  it('starts from the details the account has, with the email shown but not editable', async () => {
    await renderWithClient(<EditProfileScreen />);

    expect(field('Full name').props.value).toBe('Asha Rao');
    expect(field('Mobile number').props.value).toBe('+919876543210');
    expect(field('Email').props.value).toBe('asha@example.com');
    expect(field('Email').props.editable).toBe(false);
    expect(screen.getByText(/can’t be changed here/)).toBeOnTheScreen();
  });

  it('sends ONLY what changed, and shows the saved details everywhere through the signed-in customer', async () => {
    const { setCustomer } = authState.current;
    accountApi.profileApi.update.mockResolvedValue(saved({ city: 'Hyderabad', postal_code: '500001' }));
    await renderWithClient(<EditProfileScreen />);

    await fireEvent.changeText(field('City'), '  Hyderabad ');
    await fireEvent.changeText(field('Postal code'), '500001');
    await fireEvent.press(screen.getByRole('button', { name: 'Save details' }));

    expect(await screen.findByText('Your details are saved.')).toBeOnTheScreen();
    expect(accountApi.profileApi.update).toHaveBeenCalledTimes(1);
    expect(accountApi.profileApi.update).toHaveBeenCalledWith({ city: 'Hyderabad', postal_code: '500001' });
    expect(setCustomer).toHaveBeenCalledWith(expect.objectContaining({ city: 'Hyderabad' }));
  });

  it('does not ask the server anything when nothing changed', async () => {
    await renderWithClient(<EditProfileScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Save details' }));
    expect(await screen.findByText('Nothing has changed.')).toBeOnTheScreen();
    expect(accountApi.profileApi.update).not.toHaveBeenCalled();
  });

  it('catches a mistake before sending anything', async () => {
    await renderWithClient(<EditProfileScreen />);
    await fireEvent.changeText(field('Mobile number'), '12345');
    await fireEvent.changeText(field('Date of birth (YYYY-MM-DD)'), 'long ago');
    await fireEvent.press(screen.getByRole('button', { name: 'Save details' }));

    expect(await screen.findByText(/valid mobile number/)).toBeOnTheScreen();
    expect(screen.getByText(/YYYY-MM-DD, for example/)).toBeOnTheScreen();
    expect(accountApi.profileApi.update).not.toHaveBeenCalled();
  });

  it('clears a field by sending null, and picks a gender with one tap (a second tap un-picks it)', async () => {
    authState.current = { ...authState.current, customer: saved({ city: 'Hyderabad' }) };
    accountApi.profileApi.update.mockResolvedValue(saved());
    await renderWithClient(<EditProfileScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Female' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Female' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Other' }));
    await fireEvent.changeText(field('City'), '');
    await fireEvent.press(screen.getByRole('button', { name: 'Save details' }));

    await waitFor(() => expect(accountApi.profileApi.update).toHaveBeenCalledWith({ gender: 'Other', city: null }));
  });

  it('shows the server’s own sentence when it refuses, such as a mobile number already on another account', async () => {
    accountApi.profileApi.update.mockRejectedValue(
      new ApiError('validation', { status: 400, message: 'That mobile number is already registered to another account' }),
    );
    await renderWithClient(<EditProfileScreen />);
    await fireEvent.changeText(field('Mobile number'), '+919000000009');
    await fireEvent.press(screen.getByRole('button', { name: 'Save details' }));

    expect(await screen.findByText('That mobile number is already registered to another account')).toBeOnTheScreen();
    expect(screen.queryByText('Your details are saved.')).toBeNull();
  });

  it('warns that changing a verified mobile number makes it unverified, only when it is verified', async () => {
    authState.current = { ...authState.current, customer: saved({ mobile_verified: true }) };
    await renderWithClient(<EditProfileScreen />);
    expect(screen.getByText('Changing your number marks it as not verified.')).toBeOnTheScreen();
  });

  it('will not remove the mobile number from an account that has no email, since it is how they sign in', async () => {
    authState.current = { ...authState.current, customer: saved({ email: null }) };
    await renderWithClient(<EditProfileScreen />);
    await fireEvent.changeText(field('Mobile number'), '');
    await fireEvent.press(screen.getByRole('button', { name: 'Save details' }));

    expect(await screen.findByText(/how you sign in, so it can’t be removed/)).toBeOnTheScreen();
    expect(accountApi.profileApi.update).not.toHaveBeenCalled();
  });

  it('offers a guest an account instead of a form', async () => {
    signInAsGuest();
    await renderWithClient(<EditProfileScreen />);
    expect(screen.getByText('Create an account to add your details')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Full name')).toBeNull();
  });

  it('asks a signed-out visitor to sign in', async () => {
    signOut();
    await renderWithClient(<EditProfileScreen />);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(screen.queryByLabelText('Full name')).toBeNull();
  });
});
