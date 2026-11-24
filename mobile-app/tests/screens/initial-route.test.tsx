import { readFileSync } from 'fs';
import { resolve } from 'path';

jest.mock('expo-font', () => ({ useFonts: () => [true, null] }));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('expo-router', () => ({
  SplashScreen: { preventAutoHideAsync: jest.fn(), hide: jest.fn() },
  Stack: Object.assign(() => null, { Screen: () => null, Protected: () => null }),
}));
jest.mock('@/providers/AppProviders', () => ({ AppProviders: ({ children }: { children: unknown }) => children }));
jest.mock('@/providers/AuthProvider', () => ({ useAuth: () => ({ status: 'signedOut' }) }));
jest.mock('@/features/auth/useReturnTo', () => ({ useReturnAfterSignIn: jest.fn() }));

import { unstable_settings } from '@/app/_layout';

describe('the app’s initial navigation', () => {
  it('anchors the root stack on the tabs, so Home is the base once there is a session', () => {
    expect(unstable_settings).toEqual({ anchor: '(tabs)' });
  });

  it('the anchor names a group that exists and is the Home tab’s group', () => {
    const tabsLayout = resolve(__dirname, '../../src/app/(tabs)/_layout.tsx');
    expect(readFileSync(tabsLayout, 'utf8')).toContain('<Tabs.Screen name="index"');
    expect(unstable_settings.anchor).toBe('(tabs)');
  });

  it('opens on sign-in when there is no session: the tabs are protected and redirect there', () => {
    const layout = readFileSync(resolve(__dirname, '../../src/app/_layout.tsx'), 'utf8');
    expect(layout).toContain("const canBrowse = status !== 'signedOut';");
    expect(layout).toContain('<Stack.Protected guard={canBrowse} redirectTo="/sign-in">');
  });

  it('keeps sign-in protected and removed once someone is signed in to an account; a modal for a guest, a first screen otherwise', () => {
    const layout = readFileSync(resolve(__dirname, '../../src/app/_layout.tsx'), 'utf8');
    expect(layout).toContain("<Stack.Protected guard={status !== 'customer'}>");
    expect(layout).toContain("options={canBrowse ? { presentation: 'modal' } : { presentation: 'card', gestureEnabled: false, animation: 'fade' }}");
  });
});
