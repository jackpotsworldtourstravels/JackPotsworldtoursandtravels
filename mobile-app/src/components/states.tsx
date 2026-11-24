import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Animated, StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';

import { isApiError } from '@/api/errors';
import { colors, fontFamily, radius, shadow, spacing } from '@/theme';

import { Button } from './Button';
import { CircleLoader, TakeoffLoader, useLoop } from './Loader';
import { Text } from './Text';

/** A centred block shared by the loading, empty, error and unavailable states. */
function Center({ children }: { children: ReactNode }) {
  return <View style={styles.center}>{children}</View>;
}

/** The icon of a state, in a soft circle. */
function Badge({ icon, tone = 'neutral' }: { icon: keyof typeof Ionicons.glyphMap; tone?: 'neutral' | 'error' }) {
  return (
    <View style={[styles.badge, tone === 'error' && styles.badgeError]}>
      <Ionicons name={icon} size={34} color={tone === 'error' ? colors.danger : colors.link} />
    </View>
  );
}

/** A small inline spinner. Lists and pages use `Skeleton` shapes instead, so a screen is never a spinner on a blank page. */
export function LoadingState({ message = 'Loading…' }: { message?: string }) {
  return (
    <Center>
      <TakeoffLoader width={180} label={message} />
      <Text variant="small" color="textSecondary" align="center" accessibilityLiveRegion="polite">
        {message}
      </Text>
    </Center>
  );
}

export interface EmptyStateProps {
  title: string;
  message?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ title, message, icon = 'compass-outline', actionLabel, onAction }: EmptyStateProps) {
  return (
    <Center>
      <Badge icon={icon} />
      <Text variant="h3" color="ink" align="center" accessibilityRole="header">
        {title}
      </Text>
      {message ? (
        <Text variant="body" color="textSecondary" align="center">
          {message}
        </Text>
      ) : null}
      {actionLabel && onAction ? <Button title={actionLabel} onPress={onAction} variant="primary" fullWidth={false} style={styles.action} /> : null}
    </Center>
  );
}

export interface ErrorStateProps {
  /** Anything thrown by an API call. Its message is already safe to show. */
  error?: unknown;
  title?: string;
  onRetry?: () => void;
  retrying?: boolean;
}

/** A failed load with a way out. Offline and timeouts say so; nothing leaks internals. */
export function ErrorState({ error, title, onRetry, retrying }: ErrorStateProps) {
  const apiError = isApiError(error) ? error : null;
  const offline = apiError?.kind === 'network' || apiError?.kind === 'timeout';
  return (
    <Center>
      <Badge icon={offline ? 'cloud-offline-outline' : 'alert-circle-outline'} tone="error" />
      <Text variant="h3" color="ink" align="center" accessibilityRole="header">
        {title ?? (offline ? "You're offline" : 'Something went wrong')}
      </Text>
      <Text variant="body" color="textSecondary" align="center">
        {apiError?.message ?? 'Something went wrong. Please try again.'}
      </Text>
      {onRetry ? <Button title="Try again" icon="refresh" onPress={onRetry} loading={retrying} variant="outline" fullWidth={false} style={styles.action} /> : null}
    </Center>
  );
}

export interface UnavailableStateProps {
  title: string;
  message: string;
  icon?: keyof typeof Ionicons.glyphMap;
  actionLabel?: string;
  actionIcon?: keyof typeof Ionicons.glyphMap;
  onAction?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}

/**
 * For a service whose provider is not connected (flights while the backend reports a demo supplier). It says so
 * plainly and offers the honest next step; it never shows a sample result as if it were real.
 */
export function UnavailableState({ title, message, icon = 'airplane-outline', actionLabel, actionIcon, onAction, secondaryLabel, onSecondary }: UnavailableStateProps) {
  return (
    <Center>
      <Badge icon={icon} />
      <Text variant="h2" color="ink" align="center" accessibilityRole="header">
        {title}
      </Text>
      <Text variant="body" color="textSecondary" align="center">
        {message}
      </Text>
      {actionLabel && onAction ? <Button title={actionLabel} icon={actionIcon} onPress={onAction} style={styles.wideAction} /> : null}
      {secondaryLabel && onSecondary ? <Button title={secondaryLabel} variant="ghost" onPress={onSecondary} fullWidth={false} /> : null}
    </Center>
  );
}

/** One placeholder block, shaped like the content that will replace it. */
type Pulse = Animated.AnimatedInterpolation<number>;

export function Skeleton({ width = '100%', height, radius: r = radius.sm, style, pulse }: { width?: DimensionValue; height: number; radius?: number; style?: StyleProp<ViewStyle>; pulse?: Pulse }) {
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width, height, borderRadius: r, backgroundColor: colors.skeleton }, pulse ? { opacity: pulse } : null, style]}
    />
  );
}

/** A result card's skeleton: photo, two lines, a pill and a price. */
export function CardSkeleton({ photo = 170, pulse }: { photo?: number; pulse?: Pulse }) {
  return (
    <View style={styles.skCard} accessibilityLabel="Loading" accessibilityRole="progressbar">
      <Skeleton height={photo} radius={0} pulse={pulse} />
      <View style={styles.skBody}>
        <Skeleton width="62%" height={16} pulse={pulse} />
        <Skeleton width="44%" height={12} pulse={pulse} />
        <View style={styles.skRow}>
          <Skeleton width={110} height={24} radius={radius.pill} pulse={pulse} />
          <Skeleton width={84} height={20} pulse={pulse} />
        </View>
      </View>
    </View>
  );
}

/**
 * A list's worth of card skeletons, breathing gently so the wait reads as work in progress. With a `label`, a navy
 * pill with the small gold loader says what is being fetched ("Finding stays…") above the cards.
 */
export function ListSkeleton({ count = 3, photo, label }: { count?: number; photo?: number; label?: string }) {
  const t = useLoop(1400);
  // Only the grey shapes breathe, not the cards: fading a card with a shadow draws a box inside it on Android.
  const pulse = t.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.5, 1] });
  return (
    <View style={styles.skList}>
      {label ? (
        <View style={styles.pill} accessibilityLiveRegion="polite">
          <CircleLoader size={18} tone="onDark" label={label} />
          <Text variant="small" chrome color="white" style={styles.pillText}>
            {label}
          </Text>
        </View>
      ) : null}
      {Array.from({ length: count }, (_, i) => (
        <CardSkeleton key={i} photo={photo} pulse={pulse} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', gap: spacing.s3, paddingVertical: spacing.s8, paddingHorizontal: spacing.s5 },
  badge: { width: 76, height: 76, borderRadius: 38, backgroundColor: colors.sand, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.s1 },
  badgeError: { backgroundColor: colors.dangerSoft },
  action: { marginTop: spacing.s2 },
  wideAction: { marginTop: spacing.s3, alignSelf: 'stretch' },
  skCard: { backgroundColor: colors.surface, borderRadius: radius.md, overflow: 'hidden', ...shadow.sm },
  skBody: { padding: spacing.s4, gap: spacing.s2 },
  skRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.s2 },
  skList: { gap: spacing.s3 },
  pill: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: spacing.s2, height: 32, borderRadius: 16, backgroundColor: colors.primary, paddingLeft: 7, paddingRight: spacing.s3 },
  pillText: { fontFamily: fontFamily.sansBold },
});
