import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { isApiError } from '@/api/errors';
import { AuthGate, Banner, Button, Card, EmptyState, ErrorState, LoadingState, Screen, Text } from '@/components';
import { useDeleteTraveller, useTravellers } from '@/features/account/hooks';
import { passportHint, travellerName } from '@/features/account/travellerForm';
import { useOnce } from '@/hooks/useOnce';
import { spacing } from '@/theme';
import type { SavedTraveller } from '@/types/account';
import { formatLongDate, isISODate } from '@/utils/dates';

function TravellerCard({ traveller }: { traveller: SavedTraveller }) {
  const router = useRouter();
  const remove = useDeleteTraveller();
  const removeOnce = useOnce(remove.mutateAsync);
  const [confirming, setConfirming] = useState(false);
  const hint = passportHint(traveller);
  const expiry = traveller.passport_expiry && isISODate(traveller.passport_expiry) ? `expires ${formatLongDate(traveller.passport_expiry)}` : null;
  const kind = traveller.traveller_type[0].toUpperCase() + traveller.traveller_type.slice(1);

  return (
    <Card style={styles.card}>
      <Text variant="title" color="navy800">
        {travellerName(traveller)}
      </Text>
      <Text variant="small" color="muted">
        {[kind, hint, expiry].filter(Boolean).join(' · ')}
      </Text>
      {confirming ? (
        <View style={styles.confirm}>
          <Banner tone="warning" message={`Remove ${travellerName(traveller)} from your saved travellers? This doesn’t affect any booking you’ve made.`} />
          {remove.isError ? (
            <Banner tone="error" message={isApiError(remove.error) ? remove.error.message : 'We couldn’t remove that. Please try again.'} />
          ) : null}
          <Button title="Yes, remove" variant="danger" loading={remove.isPending} onPress={() => removeOnce(traveller.customer_traveller_id)} />
          <Button title="Keep" variant="ghost" disabled={remove.isPending} onPress={() => setConfirming(false)} />
        </View>
      ) : (
        <View style={styles.actions}>
          <Button
            title="Edit"
            variant="outline"
            fullWidth={false}
            accessibilityLabel={`Edit ${travellerName(traveller)}`}
            onPress={() => router.push({ pathname: '/travellers/edit', params: { id: String(traveller.customer_traveller_id) } })}
          />
          <Button
            title="Remove"
            variant="ghost"
            fullWidth={false}
            accessibilityLabel={`Remove ${travellerName(traveller)}`}
            onPress={() => setConfirming(true)}
          />
        </View>
      )}
    </Card>
  );
}

function TravellerList() {
  const router = useRouter();
  const travellers = useTravellers();

  if (travellers.isPending) return <LoadingState message="Loading your travellers…" />;
  if (travellers.isError) return <ErrorState error={travellers.error} onRetry={() => void travellers.refetch()} retrying={travellers.isRefetching} />;

  return (
    <View style={styles.list}>
      {travellers.data.length === 0 ? (
        <EmptyState
          icon="people-outline"
          title="No saved travellers"
          message="Save the people you travel with and pick them when you book, instead of typing names and passport details each time."
        />
      ) : (
        travellers.data.map((t) => <TravellerCard key={t.customer_traveller_id} traveller={t} />)
      )}
      <Button title="Add a traveller" onPress={() => router.push('/travellers/edit')} />
      <Text variant="small" color="muted" align="center">
        Saved on your account so you don’t have to type them again. You can remove anyone at any time.
      </Text>
    </View>
  );
}

export default function TravellersScreen() {
  return (
    <Screen header={{ title: 'Saved travellers', back: true }} scroll>
      <AuthGate title="Saved travellers" message="Sign in to save the people you travel with.">
        <TravellerList />
      </AuthGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.s3 },
  card: { gap: spacing.s2 },
  actions: { flexDirection: 'row', gap: spacing.s2, alignItems: 'center' },
  confirm: { gap: spacing.s2 },
});
