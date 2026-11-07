import { StyleSheet, View } from 'react-native';

import { AuthGate, Banner, Card, EmptyState, ErrorState, LoadingState, Screen, Text } from '@/components';
import { describeSession, formatWhen } from '@/features/account/format';
import { useSessions } from '@/features/account/hooks';
import { spacing } from '@/theme';

function SessionList() {
  const sessions = useSessions();
  if (sessions.isPending) return <LoadingState message="Loading your sessions…" />;
  if (sessions.isError) return <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} retrying={sessions.isRefetching} />;
  if (sessions.data.length === 0) {
    return <EmptyState icon="phone-portrait-outline" title="No other sessions" message="Nothing else is signed in to your account right now." />;
  }
  return (
    <View style={styles.list}>
      {sessions.data.map((s) => (
        <Card key={s.id} style={styles.item}>
          <Text variant="bodyStrong" color="navy800">
            {describeSession(s)}
          </Text>
          <Text variant="small" color="muted">
            Signed in {formatWhen(s.login_at)} · last active {formatWhen(s.last_seen_at)}
          </Text>
        </Card>
      ))}
    </View>
  );
}

/**
 * Where the account is signed in, as the server records it. Read-only: the backend
 * has no way to end one session on its own, and signing out ends every session, so
 * the screen says so rather than offering a control that would not do what it implies.
 */
export default function SessionsScreen() {
  return (
    <Screen header={{ title: 'Where you’re signed in', back: true }} scroll>
      <AuthGate title="Where you’re signed in" message="Sign in to see where your account is signed in.">
        <Banner tone="info" message="Signing out on this phone signs you out everywhere. If you don’t recognise a session, sign out, then contact support." />
        <SessionList />
      </AuthGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.s3 },
  item: { gap: spacing.s1 },
});
