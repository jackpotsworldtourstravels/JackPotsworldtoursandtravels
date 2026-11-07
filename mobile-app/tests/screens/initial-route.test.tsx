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
  it('anchors the root stack on the tabs, so Home is the base and sign-in is a modal above it', () => {
    expect(unstable_settings).toEqual({ anchor: '(tabs)' });
  });

  it('the anchor names a group that exists and is the Home tab’s group', () => {
    const tabsLayout = resolve(__dirname, '../../src/app/(tabs)/_layout.tsx');
    expect(readFileSync(tabsLayout, 'utf8')).toContain('<Tabs.Screen name="index"');
    expect(unstable_settings.anchor).toBe('(tabs)');
  });

  it('still keeps sign-in a protected modal that is removed once someone is signed in to an account', () => {
    const layout = readFileSync(resolve(__dirname, '../../src/app/_layout.tsx'), 'utf8');
    expect(layout).toContain("<Stack.Protected guard={status !== 'customer'}>");
    expect(layout).toContain("name=\"(auth)\" options={{ presentation: 'modal' }}");
  });
});
