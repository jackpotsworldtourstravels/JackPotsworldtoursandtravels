import { StyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';

import { colors, radius, shadow, spacing } from '@/theme';

export interface CardProps extends ViewProps {
  style?: StyleProp<ViewStyle>;
  /** Drop the padding for edge-to-edge content such as a photo header. */
  flush?: boolean;
}

/** White surface, 12px corners and the one soft card shadow. No border: a card has a shadow or an edge, never both. */
export function Card({ style, flush = false, ...rest }: CardProps) {
  return <View {...rest} style={[styles.card, flush ? null : styles.padded, style]} />;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    overflow: 'hidden',
    ...shadow.sm,
  },
  padded: { padding: spacing.s4, gap: spacing.s3 },
});
