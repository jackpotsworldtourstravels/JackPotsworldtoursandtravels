import { useFonts } from 'expo-font';
import { SplashScreen, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { useReturnAfterSignIn } from '@/features/auth/useReturnTo';
import { AppProviders } from '@/providers/AppProviders';
import { useAuth } from '@/providers/AuthProvider';
import { fontAssets } from '@/theme';

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

  return (
    <>
      {/* Every screen opens under the navy brand header, so the status bar is light. */}
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false }}>
        {/* Browsing is public, as on the website. */}
        <Stack.Screen name="(tabs)" />
        {/* Sign-in is unreachable once someone is signed in to an account, so the back stack
            can never return them to it. A GUEST is not signed in to an account, and must be
            able to reach it: signing in or creating an account from a guest session is what
            carries the guest's bookings, wishlist and tickets onto the account (the claim in
            AuthProvider). */}
        <Stack.Protected guard={status !== 'customer'}>
          <Stack.Screen name="(auth)" options={{ presentation: 'modal' }} />
        </Stack.Protected>
      </Stack>
    </>
  );
}
