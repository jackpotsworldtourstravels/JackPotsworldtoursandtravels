import { Ionicons } from '@expo/vector-icons';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, shadow, spacing } from '@/theme';

import { Text } from './Text';

/**
 * A short confirmation that floats above the bottom of the screen ("Saved to wishlist") and dismisses itself.
 * Announced to screen readers. Errors that need action belong in an `ErrorState` or a `Banner`, not here.
 */
export function Toast({ message, visible, onHide, tone = 'success', duration = 2600 }: { message: string; visible: boolean; onHide: () => void; tone?: 'success' | 'info'; duration?: number }) {
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (!visible) return undefined;
    const t = setTimeout(onHide, duration);
    return () => clearTimeout(t);
  }, [visible, onHide, duration]);
  if (!visible) return null;
  return (
    <View style={[styles.wrap, { bottom: spacing.s6 + insets.bottom }]} pointerEvents="none">
      <View style={styles.toast} accessibilityLiveRegion="polite" accessibilityRole="alert">
        <Ionicons name={tone === 'success' ? 'checkmark-circle' : 'information-circle'} size={18} color={tone === 'success' ? colors.gold : colors.white} />
        <Text variant="bodyStrong" color="white" chrome style={styles.text}>
          {message}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: spacing.s4, right: spacing.s4, alignItems: 'center' },
  toast: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2, paddingVertical: spacing.s3, paddingHorizontal: spacing.s4, borderRadius: radius.pill, backgroundColor: colors.navy900, ...shadow.md },
  text: { flexShrink: 1 },
});
