import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors, minTouchTarget, radius, spacing } from '@/theme';

import { Text } from './Text';

/**
 * A labelled tick box. The whole row is the button (at least 48dp tall), it is announced as a checkbox with
 * its state, and an error is read out when it appears.
 */
export function Checkbox({
  label,
  checked,
  onChange,
  error,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  error?: string;
}) {
  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => onChange(!checked)}
        accessibilityRole="checkbox"
        accessibilityLabel={label}
        accessibilityState={{ checked }}
        aria-checked={checked}
        style={styles.row}
      >
        <View style={[styles.box, checked && styles.boxChecked, error ? styles.boxError : null]}>
          {checked ? <Ionicons name="checkmark" size={18} color={colors.white} /> : null}
        </View>
        <Text variant="body" color="ink" style={styles.label}>
          {label}
        </Text>
      </Pressable>
      {error ? (
        <Text variant="small" color="danger" accessibilityRole="alert" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.s1 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.s3, minHeight: minTouchTarget },
  box: {
    width: 26,
    height: 26,
    marginTop: 2,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: colors.line,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxChecked: { backgroundColor: colors.navy800, borderColor: colors.navy800 },
  boxError: { borderColor: colors.danger },
  label: { flex: 1 },
});
