import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';

import { colors, radius, spacing } from '@/theme';

import { Text } from './Text';

export type BannerTone = 'info' | 'success' | 'warning' | 'error';

const TONES = {
  info: { bg: 'infoSoft', fg: 'info', icon: 'information-circle-outline' },
  success: { bg: 'successSoft', fg: 'success', icon: 'checkmark-circle-outline' },
  warning: { bg: 'warningSoft', fg: 'warning', icon: 'alert-circle-outline' },
  error: { bg: 'dangerSoft', fg: 'danger', icon: 'close-circle-outline' },
} as const;

/** An inline status message: session expired, offline, payment pending, and so on. */
export function Banner({ tone = 'info', message }: { tone?: BannerTone; message: string }) {
  const t = TONES[tone];
  return (
    <View
      style={[styles.box, { backgroundColor: colors[t.bg] }]}
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
      accessibilityLiveRegion="polite"
    >
      <Ionicons name={t.icon} size={22} color={colors[t.fg]} />
      <Text variant="small" color={t.fg} style={styles.text}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.s3,
    padding: spacing.s4,
    borderRadius: radius.md,
  },
  text: { flex: 1 },
});
