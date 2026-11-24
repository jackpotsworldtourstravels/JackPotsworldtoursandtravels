import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, minTouchTarget, spacing } from '@/theme';

import { CircleLoader } from './Loader';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'coral';

export interface ButtonProps {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  /** Shows a spinner and ignores presses, so a slow request can't be fired twice. */
  loading?: boolean;
  disabled?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  fullWidth?: boolean;
  /** Upper-case tracked label, for the main search CTAs ("SEARCH FLIGHTS"). The accessible name keeps the title as written. */
  caps?: boolean;
  /** `sm` is a 40px button for card footers and inline actions. */
  size?: 'md' | 'sm';
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

const LABEL_COLOR = {
  primary: 'white',
  coral: 'white',
  secondary: 'white',
  outline: 'link',
  ghost: 'link',
  danger: 'white',
} as const;

/**
 * The app's button: 14px corners in every variant.
 *   primary          solid brand navy, white label: THE primary action of a screen (Search, Continue, Pay)
 *   coral            solid coral, for the few website-style forms that keep the coral submit
 *   secondary        solid navy
 *   outline          supporting-navy edge and label
 *   ghost            text only, supporting navy ("Change search", "View All")
 *   danger           solid dark red (never coral, so it can't be mistaken for the primary action)
 * Press feedback is a slight scale and dim on every platform.
 */
export function Button({
  title,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  icon,
  fullWidth = true,
  caps = false,
  size = 'md',
  accessibilityLabel,
  accessibilityHint,
  testID,
  style,
}: ButtonProps) {
  const inactive = disabled || loading;
  const labelColor = LABEL_COLOR[variant];

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        size === 'sm' && styles.small,
        fullWidth ? styles.fullWidth : styles.hug,
        variant === 'primary' && styles.primary,
        variant === 'coral' && styles.coral,
        variant === 'secondary' && styles.secondary,
        variant === 'outline' && styles.outline,
        variant === 'ghost' && styles.ghost,
        variant === 'danger' && styles.danger,
        // A button that is working keeps its full colour, so the gold circle reads clearly; only a disabled one fades.
        disabled && !loading && styles.inactive,
        pressed && !inactive && styles.pressed,
        style,
      ]}
    >
      <View style={styles.row}>
        {loading ? (
          <CircleLoader size={20} tone={labelColor === 'white' ? 'onDark' : 'onLight'} label={`${title}, in progress`} />
        ) : (
          <>
            {icon ? <Ionicons name={icon} size={size === 'sm' ? 16 : 19} color={colors[labelColor]} /> : null}
            <Text variant="button" color={labelColor} chrome numberOfLines={1} style={[size === 'sm' && styles.smallLabel, caps && styles.caps]}>
              {title}
            </Text>
          </>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: minTouchTarget + 4,
    borderRadius: 14,
    paddingHorizontal: spacing.s6,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  small: { minHeight: 40, paddingHorizontal: spacing.s4 },
  smallLabel: { fontSize: 13, lineHeight: 18 },
  caps: { textTransform: 'uppercase', letterSpacing: 0.6, fontSize: 15 },
  fullWidth: { alignSelf: 'stretch' },
  hug: { alignSelf: 'flex-start' },
  primary: {
    backgroundColor: colors.primary,
    shadowColor: colors.navy900,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
    elevation: 2,
  },
  coral: {
    backgroundColor: colors.coral,
    shadowColor: colors.coral,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.22,
    shadowRadius: 8,
    elevation: 2,
  },
  secondary: { backgroundColor: colors.navy900 },
  outline: { borderWidth: 1.5, borderColor: colors.link, backgroundColor: colors.surface },
  ghost: { backgroundColor: 'transparent', paddingHorizontal: spacing.s3 },
  danger: { backgroundColor: colors.danger },
  inactive: { opacity: 0.5 },
  pressed: { opacity: 0.88, transform: [{ scale: 0.98 }] },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.s2 },
});
