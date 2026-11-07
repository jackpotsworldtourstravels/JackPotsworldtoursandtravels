import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { isApiError } from '@/api/errors';
import { colors, spacing } from '@/theme';

import { Button } from './Button';
import { Text } from './Text';

/** A centred block shared by the loading, empty and error states. */
function Center({ children }: { children: React.ReactNode }) {
  return <View style={styles.center}>{children}</View>;
}

export function LoadingState({ message = 'Loading…' }: { message?: string }) {
  return (
    <Center>
      <ActivityIndicator size="large" color={colors.goldInk} accessibilityLabel={message} />
      <Text variant="small" color="muted" align="center" accessibilityLiveRegion="polite">
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
      <Ionicons name={icon} size={44} color={colors.goldInk} />
      <Text variant="h3" color="navy800" align="center" accessibilityRole="header">
        {title}
      </Text>
      {message ? (
        <Text variant="body" color="muted" align="center">
          {message}
        </Text>
      ) : null}
      {actionLabel && onAction ? (
        <Button title={actionLabel} onPress={onAction} variant="secondary" fullWidth={false} />
      ) : null}
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
      <Ionicons name={offline ? 'cloud-offline-outline' : 'alert-circle-outline'} size={44} color={colors.danger} />
      <Text variant="h3" color="navy800" align="center" accessibilityRole="header">
        {title ?? (offline ? "You're offline" : 'Something went wrong')}
      </Text>
      <Text variant="body" color="muted" align="center">
        {apiError?.message ?? 'Something went wrong. Please try again.'}
      </Text>
      {onRetry ? <Button title="Try again" onPress={onRetry} loading={retrying} variant="secondary" fullWidth={false} /> : null}
    </Center>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', gap: spacing.s3, paddingVertical: spacing.s8, paddingHorizontal: spacing.s4 },
});
