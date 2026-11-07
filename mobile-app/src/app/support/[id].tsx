import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';

import { isApiError } from '@/api/errors';
import { AuthGate, Banner, Button, Card, EmptyState, ErrorState, LoadingState, Screen, Text } from '@/components';
import { formatWhen } from '@/features/account/format';
import { accountKeys, useSupportTicket } from '@/features/account/hooks';
import { ticketStatusLabel } from '@/features/account/support';
import { parseId } from '@/features/booking/refs';
import { colors, radius, spacing } from '@/theme';
import type { SupportMessage } from '@/types/account';

function Message({ message }: { message: SupportMessage }) {
  const staff = message.is_staff;
  return (
    <View style={[styles.bubble, staff ? styles.staff : styles.mine]}>
      <Text variant="caption" color={staff ? 'goldInk' : 'muted'} chrome>
        {staff ? 'JackpotsWorld team' : 'You'} · {formatWhen(message.created_at)}
      </Text>
      <Text variant="body" color="ink" selectable>
        {message.message}
      </Text>
    </View>
  );
}

function TicketThread({ id }: { id: number }) {
  const router = useRouter();
  const ticket = useSupportTicket(id);

  if (ticket.isPending) return <LoadingState message="Loading your request…" />;
  if (ticket.isError) {
    const missing = isApiError(ticket.error) && ticket.error.kind === 'not_found';
    return missing ? (
      <EmptyState icon="chatbubbles-outline" title="We couldn’t find that request" message="It isn’t on this account." />
    ) : (
      <ErrorState error={ticket.error} onRetry={() => void ticket.refetch()} retrying={ticket.isRefetching} />
    );
  }

  const data = ticket.data;
  const messages = data.messages ?? [];
  return (
    <View style={styles.stack}>
      <Card style={styles.head}>
        <Text variant="eyebrow" color="goldInk">
          {ticketStatusLabel(data.status)}
        </Text>
        <Text variant="h3" color="navy800" accessibilityRole="header">
          {data.subject}
        </Text>
        <Text variant="small" color="muted">
          Sent {formatWhen(data.created_at)}
        </Text>
      </Card>

      {messages.length === 0 ? <Message message={{ id: 0, author_name: null, is_staff: false, message: data.description, created_at: data.created_at }} /> : null}
      {messages.map((m) => (
        <Message key={m.id} message={m} />
      ))}

      <Banner
        tone="info"
        message="This is an earlier request, kept so you can read it. New messages go to our team by email, and replies to this one are no longer read here."
      />
      <Button
        title="Send a new message about this"
        onPress={() => router.push({ pathname: '/support/new', params: { subject: `About: ${data.subject}` } })}
      />
    </View>
  );
}

export default function TicketScreen() {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const params = useLocalSearchParams<{ id: string }>();
  const id = parseId(Array.isArray(params.id) ? params.id[0] : params.id);

  return (
    <Screen
      header={{ title: 'Your request', back: true }}
      scroll
      keyboard
      bottomInset
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={colors.goldInk}
          onRefresh={async () => {
            setRefreshing(true);
            try {
              if (id !== null) await queryClient.invalidateQueries({ queryKey: accountKeys.ticket(id) });
            } finally {
              setRefreshing(false);
            }
          }}
        />
      }
    >
      <AuthGate title="Your request" message="Sign in to read your earlier requests.">
        {id === null ? <EmptyState icon="chatbubbles-outline" title="We couldn’t find that request" message="The link may be old or mistyped." /> : <TicketThread id={id} />}
      </AuthGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.s3 },
  head: { gap: spacing.s1 },
  bubble: { gap: spacing.s1, padding: spacing.s4, borderRadius: radius.lg, maxWidth: '92%' },
  mine: { alignSelf: 'flex-end', backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  staff: { alignSelf: 'flex-start', backgroundColor: colors.surface2 },
});
