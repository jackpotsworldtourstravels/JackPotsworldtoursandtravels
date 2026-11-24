import { Ionicons } from '@expo/vector-icons';
import { RefreshControl, StyleSheet, View } from 'react-native';

import { AuthGate, EmptyState, ErrorState, ListSkeleton, Screen, Text } from '@/components';
import { useMarkAllRead, useNotifications } from '@/features/account/hooks';
import { colors, radius, spacing } from '@/theme';
import type { AppNotification } from '@/types/account';

type IconName = keyof typeof Ionicons.glyphMap;

/** Icon and tint by notification type; anything new falls back to the bell. */
function look(type: string): { icon: IconName; fg: string; bg: string } {
  const t = type.toLowerCase();
  if (t.includes('pay')) return { icon: 'time-outline', fg: colors.warning, bg: colors.warningSoft };
  if (t.includes('refund')) return { icon: 'refresh-outline', fg: colors.info, bg: colors.infoSoft };
  if (t.includes('cancel')) return { icon: 'close-circle-outline', fg: colors.danger, bg: colors.dangerSoft };
  if (t.includes('book') || t.includes('confirm')) return { icon: 'checkmark-circle-outline', fg: colors.success, bg: colors.successSoft };
  if (t.includes('support') || t.includes('message') || t.includes('chat')) return { icon: 'chatbubble-ellipses-outline', fg: colors.primary, bg: colors.surface2 };
  return { icon: 'notifications-outline', fg: colors.goldInk, bg: '#FBF3DF' };
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return 'Now';
  if (mins < 60) return `${mins} min`;
  if (mins < 24 * 60 && d.getDate() === new Date().getDate()) return `${Math.round(mins / 60)} h`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString();
}

function Row({ item }: { item: AppNotification }) {
  const l = look(item.notification_type);
  return (
    <View
      accessible
      accessibilityLabel={`${item.is_read ? '' : 'Unread. '}${item.title}. ${item.message}`}
      style={[styles.row, !item.is_read && styles.unread]}
    >
      <View style={[styles.icon, { backgroundColor: l.bg }]}>
        <Ionicons name={l.icon} size={20} color={l.fg} />
      </View>
      <View style={styles.flex}>
        <View style={styles.titleRow}>
          <Text variant="bodyStrong" color="ink" style={styles.flex}>
            {item.title}
          </Text>
          <Text variant="caption" color="textSecondary">
            {when(item.created_at)}
          </Text>
        </View>
        <Text variant="small" color="ink2">
          {item.message}
        </Text>
        {item.related_ref ? (
          <Text variant="caption" color="textSecondary">
            Ref {item.related_ref}
          </Text>
        ) : null}
      </View>
      {!item.is_read ? <View style={styles.dot} /> : null}
    </View>
  );
}

function NotificationList() {
  const list = useNotifications();
  if (list.isPending) return <ListSkeleton count={4} photo={0} />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isRefetching} />;
  if (list.data.length === 0) {
    return <EmptyState icon="notifications-outline" title="You’re all caught up" message="Booking updates, payment reminders and replies from our team will appear here." />;
  }
  const today = list.data.filter((n) => isToday(n.created_at));
  const earlier = list.data.filter((n) => !isToday(n.created_at));
  return (
    <View style={styles.list}>
      {[
        { title: 'TODAY', items: today },
        { title: 'EARLIER', items: earlier },
      ]
        .filter((g) => g.items.length > 0)
        .map((g) => (
          <View key={g.title} style={styles.group}>
            <Text variant="caption" chrome color="textSecondary" accessibilityRole="header" style={styles.groupTitle}>
              {g.title}
            </Text>
            {g.items.map((n) => (
              <Row key={n.id} item={n} />
            ))}
          </View>
        ))}
    </View>
  );
}

/** The bell on Home opens this. Mark all read clears the bell's dot. */
export default function NotificationsScreen() {
  const list = useNotifications();
  const markAll = useMarkAllRead();
  const unread = (list.data ?? []).some((n) => !n.is_read);
  return (
    <Screen
      header={{
        title: 'Notifications',
        back: true,
        tone: 'light',
        ...(unread ? { actionLabel: markAll.isPending ? 'Marking…' : 'Mark all read', onAction: () => markAll.mutate() } : {}),
      }}
      scroll
      refreshControl={<RefreshControl refreshing={list.isRefetching} onRefresh={() => void list.refetch()} tintColor={colors.goldDeep} />}
    >
      <AuthGate title="Your notifications" message="Sign in to see booking updates and messages from our team.">
        <NotificationList />
      </AuthGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  list: { gap: spacing.s4 },
  group: { gap: spacing.s2 },
  groupTitle: { letterSpacing: 0.6, paddingHorizontal: spacing.s1 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.s3,
    padding: spacing.s3,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.divider,
  },
  unread: { borderColor: '#F1D9A6' },
  icon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.s2 },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.gold, marginTop: 6 },
});
