import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { useAuthDetour } from '@/features/auth/useReturnTo';
import { useAuth } from '@/providers/AuthProvider';
import { colors, spacing } from '@/theme';

import { Banner } from './Banner';
import { Button } from './Button';
import { Card } from './Card';
import { ErrorState, LoadingState } from './states';
import { Text } from './Text';

/** What a signed-out visitor sees where an account feature would be. */
export function SignInPrompt({ title, message }: { title: string; message: string }) {
  // Signing in or up brings the visitor back to this screen (see features/auth/returnTo.ts).
  const detour = useAuthDetour();
  const { sessionExpired } = useAuth();
  return (
    <View style={styles.stack}>
      {sessionExpired ? <Banner tone="warning" message="Your session ended. Please sign in again." /> : null}
      <Card style={styles.card}>
        <Ionicons name="person-circle-outline" size={44} color={colors.goldInk} />
        <Text variant="h3" color="navy800" align="center" accessibilityRole="header">
          {title}
        </Text>
        <Text variant="body" color="muted" align="center">
          {message}
        </Text>
        <Button title="Sign in" onPress={() => detour('/sign-in')} />
        <Button title="Create account" variant="outline" onPress={() => detour('/sign-up')} />
      </Card>
    </View>
  );
}

/**
 * Wrap anything that needs a session (bookings, wishlist, profile). Public
 * browsing never goes through this; the website lets visitors browse and asks
 * them to sign in only when they want something that belongs to them.
 */
export function AuthGate({ title, message, children }: { title: string; message: string; children: ReactNode }) {
  const { status, refreshSession } = useAuth();

  if (status === 'loading') return <LoadingState />;
  if (status === 'unavailable') {
    return <ErrorState error={undefined} title="We couldn't confirm your sign-in" onRetry={() => void refreshSession()} />;
  }
  if (status === 'signedOut') return <SignInPrompt title={title} message={message} />;
  return <>{children}</>;
}

const styles = StyleSheet.create({
  stack: { gap: spacing.s4 },
  card: { alignItems: 'stretch' },
});
