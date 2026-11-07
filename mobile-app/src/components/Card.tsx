import { StyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';

import { colors, radius, shadow, spacing } from '@/theme';

export interface CardProps extends ViewProps {
  style?: StyleProp<ViewStyle>;
  /** Drop the padding for edge-to-edge content such as a photo header. */
  flush?: boolean;
}

/** White surface, 20px radius, hairline border and a navy-tinted shadow. */
export function Card({ style, flush = false, ...rest }: CardProps) {
  return <View {...rest} style={[styles.card, flush ? null : styles.padded, style]} />;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    overflow: 'hidden',
    ...shadow.sm,
  },
  padded: { padding: spacing.s5, gap: spacing.s3 },
});
