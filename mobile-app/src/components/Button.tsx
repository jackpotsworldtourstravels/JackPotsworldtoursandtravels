import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, gradients, minTouchTarget, radius, shadow, spacing } from '@/theme';

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
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

const LABEL_COLOR = {
  primary: 'white',
  secondary: 'white',
  outline: 'navy800',
  ghost: 'navy800',
  danger: 'white',
  coral: 'white',
} as const;

/**
 * The website's `.btn`: a pill, 16px/700 label. Primary is the bronze-gold
 * gradient used for the main action on every page ("Search Flights",
 * "Pay now"); secondary is solid navy.
 */
export function Button({
  title,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  icon,
  fullWidth = true,
  accessibilityLabel,
  accessibilityHint,
  testID,
  style,
}: ButtonProps) {
  const inactive = disabled || loading;
  const labelColor = LABEL_COLOR[variant];

  const content = (
    <View style={styles.row}>
      {loading ? (
        <ActivityIndicator color={colors[labelColor]} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={20} color={colors[labelColor]} /> : null}
          <Text variant="button" color={labelColor} numberOfLines={1} style={variant === 'coral' ? styles.coralLabel : undefined}>
            {title}
          </Text>
        </>
      )}
    </View>
  );

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
        fullWidth ? styles.fullWidth : styles.hug,
        variant === 'secondary' && styles.secondary,
        variant === 'outline' && styles.outline,
        variant === 'danger' && styles.danger,
        variant === 'coral' && styles.coral,
        variant === 'primary' && shadow.sm,
        inactive && styles.inactive,
        pressed && !inactive && styles.pressed,
        style,
      ]}
    >
      {variant === 'primary' ? (
        <LinearGradient
          colors={gradients.gold}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: minTouchTarget + 4,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.s6,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  fullWidth: { alignSelf: 'stretch' },
  hug: { alignSelf: 'flex-start' },
  secondary: { backgroundColor: colors.navy800 },
  outline: { borderWidth: 1.5, borderColor: colors.navy800, backgroundColor: 'transparent' },
  danger: { backgroundColor: colors.danger },
  // The service pages' submit (`.ge-submit`, `.btn-coral`): solid coral, 14px corners, 15.5px at weight 800.
  coral: { backgroundColor: colors.coral, borderRadius: 14 },
  coralLabel: { fontSize: 15.5, letterSpacing: 0.1 },
  inactive: { opacity: 0.55 },
  pressed: { transform: [{ scale: 0.97 }] },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.s2 },
});
