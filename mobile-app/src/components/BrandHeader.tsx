import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing } from '@/theme';

import { Text } from './Text';

export interface BrandHeaderProps {
  title?: string;
  /** A second line under the title: a search summary ("28 – 30 Nov · 1 Room · 2 Adults"). */
  subtitle?: string;
  right?: ReactNode;
  /** Show a back arrow. Goes back if it can, otherwise to Home. */
  back?: boolean;
  /** `close` draws an X instead of a back arrow, for full-screen pickers and modals. */
  backIcon?: 'back' | 'close';
  /** `navy` (default) is the brand band with light content; `light` is a white bar for pickers, forms and checkout. */
  tone?: 'navy' | 'light';
  /** A text action at the right ("Edit"), drawn in the header's link colour. */
  actionLabel?: string;
  onAction?: () => void;
}

/** A phone on its side has little height to give: below this the header slims down. */
const COMPACT_HEIGHT = 500;

/**
 * The app header (`AppHeader` in the overhaul brief): back arrow, title, optional subtitle and one action. No logo:
 * the brand is carried by the colours, not by repeating the mark on every screen.
 */
export function BrandHeader({ title, subtitle, right, back = false, backIcon = 'back', tone = 'navy', actionLabel, onAction }: BrandHeaderProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const compact = useWindowDimensions().height < COMPACT_HEIGHT;
  const dark = tone === 'navy';
  const fg = dark ? colors.white : colors.ink;
  return (
    <View
      style={[
        styles.bar,
        dark ? styles.navy : styles.light,
        { paddingTop: insets.top + (compact ? spacing.s1 : spacing.s2), paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right },
      ]}
    >
      {back ? (
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          accessibilityRole="button"
          accessibilityLabel={backIcon === 'close' ? 'Close' : 'Go back'}
          hitSlop={8}
          style={({ pressed }) => [styles.back, pressed && styles.pressed]}
        >
          <Ionicons name={backIcon === 'close' ? 'close' : 'chevron-back'} size={26} color={fg} />
        </Pressable>
      ) : null}
      <View style={styles.title}>
        {title ? (
          <Text variant="h2" color={dark ? 'white' : 'ink'} numberOfLines={1} accessibilityRole="header" style={subtitle ? styles.titleWithSub : undefined}>
            {title}
          </Text>
        ) : null}
        {subtitle ? (
          <Text variant="small" color={dark ? 'onDark2' : 'textSecondary'} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} accessibilityRole="button" accessibilityLabel={actionLabel} hitSlop={8} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
          <Text variant="bodyStrong" color={dark ? 'gold' : 'link'} chrome>
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', paddingBottom: spacing.s3, gap: spacing.s2, minHeight: 56 },
  navy: { backgroundColor: colors.navy900 },
  // The light bar is separated from the page by a hairline, not a shadow.
  light: { backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  back: { minWidth: 40, minHeight: 44, justifyContent: 'center', marginLeft: -spacing.s2 },
  title: { flex: 1, justifyContent: 'center', minHeight: 44 },
  titleWithSub: { fontSize: 16, lineHeight: 21 },
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.s1 },
  right: { alignItems: 'flex-end', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
});
