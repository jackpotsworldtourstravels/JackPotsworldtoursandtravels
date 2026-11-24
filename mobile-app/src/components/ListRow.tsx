import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors, minTouchTarget, spacing } from '@/theme';

import { Text } from './Text';

type IconName = ComponentProps<typeof Ionicons>['name'];

/**
 * One tappable line in a menu: icon, title, an optional second line and a
 * chevron. A real button for screen readers, at least 48dp tall, with the
 * hairline between rows drawn by the row itself so a list needs no dividers.
 */
export function ListRow({
  icon,
  title,
  subtitle,
  onPress,
  last = false,
  accessibilityHint,
  tone = 'default',
}: {
  icon: IconName;
  title: string;
  subtitle?: string;
  onPress: () => void;
  last?: boolean;
  accessibilityHint?: string;
  /** `danger` for destructive rows (Delete account): dark red icon and title. */
  tone?: 'default' | 'danger';
}) {
  const danger = tone === 'danger';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [styles.row, !last && styles.divider, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={21} color={danger ? colors.danger : colors.link} />
      <View style={styles.text}>
        <Text variant="bodyStrong" color={danger ? 'danger' : 'ink'}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="small" color="textSecondary">
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textDisabled} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, minHeight: minTouchTarget + 4, paddingVertical: spacing.s2 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider },
  pressed: { opacity: 0.7 },
  text: { flex: 1, gap: 2 },
});
