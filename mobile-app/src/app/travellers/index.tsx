import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { isApiError } from '@/api/errors';
import { AuthGate, Banner, Button, Card, EmptyState, ErrorState, ListSkeleton, Screen, Text } from '@/components';
import { useDeleteTraveller, useTravellers } from '@/features/account/hooks';
import { passportHint, travellerName } from '@/features/account/travellerForm';
import { useOnce } from '@/hooks/useOnce';
import { colors, fontFamily, spacing } from '@/theme';
import type { SavedTraveller } from '@/types/account';
import { addDays, formatLongDate, isISODate, todayISO } from '@/utils/dates';

type IconName = keyof typeof Ionicons.glyphMap;

/**
 * One line on where a traveller's passport stands. International trips need six months of validity after the trip,
 * so a passport expiring within about six months is flagged before it can spoil a booking.
 */
function passportStatus(t: SavedTraveller): { text: string; icon: IconName; fg: string; bg: string } {
  const hint = passportHint(t);
  const expiry = t.passport_expiry && isISODate(t.passport_expiry) ? t.passport_expiry : null;
  if (!hint || !expiry) return { text: 'No passport added · fine for trips within India', icon: 'add-circle-outline', fg: colors.ink2, bg: colors.surface2 };
  const today = todayISO();
  if (expiry < today) return { text: `${hint} · expired on ${formatLongDate(expiry)}`, icon: 'alert-circle-outline', fg: colors.danger, bg: colors.dangerSoft };
  if (expiry < addDays(today, 183)) {
    return { text: `${hint} · expires ${formatLongDate(expiry)} · renew before travelling abroad`, icon: 'warning-outline', fg: colors.warning, bg: colors.warningSoft };
  }
  return { text: `${hint} · valid till ${formatLongDate(expiry)}`, icon: 'checkmark-circle-outline', fg: colors.success, bg: colors.successSoft };
}

function TravellerCard({ traveller }: { traveller: SavedTraveller }) {
  const router = useRouter();
  const remove = useDeleteTraveller();
  const removeOnce = useOnce(remove.mutateAsync);
  const [confirming, setConfirming] = useState(false);
  const name = travellerName(traveller);
  const kind = traveller.traveller_type[0].toUpperCase() + traveller.traveller_type.slice(1);
  const born = traveller.date_of_birth && isISODate(traveller.date_of_birth) ? `born ${formatLongDate(traveller.date_of_birth)}` : null;
  const initials = [traveller.first_name, traveller.last_name].map((w) => w.trim()[0]?.toUpperCase() ?? '').join('');
  const status = passportStatus(traveller);

  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <View style={styles.avatar} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Text variant="bodyStrong" chrome color="navy900">
            {initials}
          </Text>
        </View>
        <View style={styles.flex}>
          <Text variant="h3" color="ink">
            {name}
          </Text>
          <Text variant="small" color="textSecondary">
            {[kind, born, traveller.nationality].filter(Boolean).join(' · ')}
          </Text>
        </View>
        {confirming ? null : (
          <View style={styles.icons}>
            <Pressable
              onPress={() => router.push({ pathname: '/travellers/edit', params: { id: String(traveller.customer_traveller_id) } })}
              accessibilityRole="button"
              accessibilityLabel={`Edit ${name}`}
              style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
            >
              <Ionicons name="create-outline" size={18} color={colors.ink2} />
            </Pressable>
            <Pressable
              onPress={() => setConfirming(true)}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${name}`}
              style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
            >
              <Ionicons name="trash-outline" size={18} color={colors.ink2} />
            </Pressable>
          </View>
        )}
      </View>
      <View style={[styles.status, { backgroundColor: status.bg }]}>
        <Ionicons name={status.icon} size={15} color={status.fg} />
        <Text variant="caption" chrome style={[styles.statusText, { color: status.fg }]}>
          {status.text}
        </Text>
      </View>
      {confirming ? (
        <View style={styles.confirm}>
          <Banner tone="warning" message={`Remove ${name} from your saved travellers? This doesn’t affect any booking you’ve made.`} />
          {remove.isError ? (
            <Banner tone="error" message={isApiError(remove.error) ? remove.error.message : 'We couldn’t remove that. Please try again.'} />
          ) : null}
          <Button title="Yes, remove" variant="danger" loading={remove.isPending} onPress={() => removeOnce(traveller.customer_traveller_id)} />
          <Button title="Keep" variant="ghost" disabled={remove.isPending} onPress={() => setConfirming(false)} />
        </View>
      ) : null}
    </Card>
  );
}

function TravellerList() {
  const router = useRouter();
  const travellers = useTravellers();

  if (travellers.isPending) return <ListSkeleton count={3} photo={0} />;
  if (travellers.isError) return <ErrorState error={travellers.error} onRetry={() => void travellers.refetch()} retrying={travellers.isRefetching} />;

  return (
    <View style={styles.list}>
      <Pressable onPress={() => router.push('/travellers/edit')} accessibilityRole="button" accessibilityLabel="Add a traveller" style={({ pressed }) => [styles.add, pressed && styles.pressed]}>
        <View style={styles.addIcon}>
          <Ionicons name="add" size={18} color={colors.navy900} />
        </View>
        <Text variant="bodyStrong" chrome color="goldInk">
          Add a traveller
        </Text>
      </Pressable>
      {travellers.data.length === 0 ? (
        <EmptyState
          icon="people-outline"
          title="No saved travellers"
          message="Save the people you travel with and pick them when you book, instead of typing names and passport details each time."
        />
      ) : (
        travellers.data.map((t) => <TravellerCard key={t.customer_traveller_id} traveller={t} />)
      )}
      <View style={styles.note}>
        <Ionicons name="lock-closed-outline" size={15} color={colors.success} />
        <Text variant="small" color="textSecondary" style={styles.flex}>
          Saved on your account so you don’t have to type them again. You can remove anyone at any time.
        </Text>
      </View>
    </View>
  );
}

export default function TravellersScreen() {
  return (
    <Screen header={{ title: 'Saved travellers', subtitle: 'Filled in for you when you book', back: true, tone: 'light' }} scroll>
      <AuthGate title="Saved travellers" message="Sign in to save the people you travel with.">
        <TravellerList />
      </AuthGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.7 },
  list: { gap: spacing.s3 },
  add: {
    minHeight: 56,
    borderRadius: 16,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.gold,
    backgroundColor: '#FFFCF4',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.s2,
  },
  addIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.gold, alignItems: 'center', justifyContent: 'center' },
  card: { gap: spacing.s3 },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
  icons: { flexDirection: 'row', gap: spacing.s1 },
  iconBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
  status: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2, borderRadius: 10, paddingHorizontal: spacing.s3, paddingVertical: spacing.s2 },
  statusText: { flex: 1, fontFamily: fontFamily.sansBold },
  confirm: { gap: spacing.s2 },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.s2, paddingHorizontal: spacing.s1 },
});
