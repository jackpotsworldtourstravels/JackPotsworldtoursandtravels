import { useFonts } from 'expo-font';
import { SplashScreen, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { useReturnAfterSignIn } from '@/features/auth/useReturnTo';
import { AppProviders } from '@/providers/AppProviders';
import { useAuth } from '@/providers/AuthProvider';
import { colors, fontAssets } from '@/theme';

// Keep the branded splash up until the fonts and the stored session are read,
// so the first frame is the real one, not a flash of system type.
SplashScreen.preventAutoHideAsync();

/**
 * HOME IS THE BASE OF THE APP. Without an anchor the router starts a launch that
 * carries no usable URL (Expo Go, the dev launcher, a restored state) at the FIRST
 * route in file order, which is `(auth)`, the sign-in modal: Metro warned that it
 * "is the first screen in its native stack". Anchoring on `(tabs)` makes Home the
 * screen under everything, with sign-in above it as the modal it is meant to be.
 * Browsing stays public, the tabs that need an account still ask through
 * `AuthGate`, and `(auth)` is still removed while someone is signed in (below).
 */
export const unstable_settings = { anchor: '(tabs)' };

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(fontAssets);
  // A font failure is not worth blocking the app for: text falls back to the
  // system face and everything still works.
  const fontsReady = fontsLoaded || fontError !== null;

  return (
    <AppProviders>
      <RootNavigator fontsReady={fontsReady} />
    </AppProviders>
  );
}

function RootNavigator({ fontsReady }: { fontsReady: boolean }) {
  const { status } = useAuth();
  const ready = fontsReady && status !== 'loading';
  const hasSession = status === 'customer' || status === 'guest';

  useEffect(() => {
    if (ready) SplashScreen.hide();
  }, [ready]);

  // After signing in from a booking form (or a signed-out tab), go back to it.
  useReturnAfterSignIn(hasSession);

  if (!ready) return null;

  // A stored session the server couldn't confirm (`unavailable`) still counts: the app opens and says it is offline,
  // rather than sending someone who is signed in back to the sign-in screen.
  const canBrowse = status !== 'signedOut';

  return (
    <>
      {/* Each Screen sets the status bar to suit its header (light on navy, dark on white/ivory); this is the default. */}
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        {/* SIGN IN FIRST. With no session at all, the tabs are not available and the router sends the visitor to
            sign-in; "Explore first" there starts a guest session, which opens them. */}
        <Stack.Protected guard={canBrowse} redirectTo="/sign-in">
          <Stack.Screen name="(tabs)" />
        </Stack.Protected>
        {/* Sign-in is unreachable once someone is signed in to an account, so the back stack
            can never return them to it. A GUEST is not signed in to an account, and must be
            able to reach it: signing in or creating an account from a guest session is what
            carries the guest's bookings, wishlist and tickets onto the account (the claim in
            AuthProvider). For a guest it is a modal over the app; with no session it is the
            first screen, so it cannot be swiped away. */}
        <Stack.Protected guard={status !== 'customer'}>
          <Stack.Screen name="(auth)" options={canBrowse ? { presentation: 'modal' } : { presentation: 'card', gestureEnabled: false, animation: 'fade' }} />
        </Stack.Protected>
      </Stack>
    </>
  );
}
