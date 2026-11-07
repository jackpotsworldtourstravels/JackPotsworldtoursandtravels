import { StyleSheet, View } from 'react-native';

import { Text } from '@/components';
import { colors, spacing } from '@/theme';

/**
 * The website's section "kicker" (`.cine-kicker`): a short gold rule and a small,
 * wide-tracked, upper-case line above a heading. Gold ink on the ivory page, light
 * gold on the dark panels.
 */
export function Kicker({ text, onDark = false }: { text: string; onDark?: boolean }) {
  return (
    <View style={styles.row}>
      <View style={[styles.rule, { backgroundColor: onDark ? colors.gold : colors.goldInk }]} />
      <Text variant="eyebrow" color={onDark ? 'gold' : 'goldInk'} style={styles.text} accessibilityRole="text">
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3 },
  rule: { width: 28, height: 1.5 },
  text: { flex: 1, letterSpacing: 3 },
});
