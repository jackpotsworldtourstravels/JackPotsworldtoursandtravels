import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing } from '@/theme';

import { Logo } from './Logo';
import { Text } from './Text';

export interface BrandHeaderProps {
  title?: string;
  right?: ReactNode;
  /** Show a back arrow. Goes back if it can, otherwise to Home. */
  back?: boolean;
}

/** A phone on its side has little height to give: below this the header slims down. */
const COMPACT_HEIGHT = 500;

/**
 * The site's dark navy header with the logo at the left. The website puts the
 * navigation in the header; on a phone that job belongs to the tab bar, so the
 * header carries identity, an optional title and an optional right-hand action.
 * Screens pushed above the tabs add a back arrow.
 */
export function BrandHeader({ title, right, back = false }: BrandHeaderProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const compact = useWindowDimensions().height < COMPACT_HEIGHT;
  return (
    <View
      style={[
        styles.bar,
        { paddingTop: insets.top + (compact ? spacing.s1 : spacing.s2), paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right },
      ]}
    >
      {back ? (
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={8}
          style={styles.back}
        >
          <Ionicons name="chevron-back" size={26} color={colors.white} />
        </Pressable>
      ) : null}
      <Logo size={compact ? 32 : 44} />
      {title ? (
        <Text variant="title" color="white" style={[styles.title, styles.titleText]} numberOfLines={2} accessibilityRole="header">
          {title}
        </Text>
      ) : (
        <View style={styles.title} />
      )}
      <View style={styles.right}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.navy900,
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: spacing.s2,
    gap: spacing.s3,
  },
  back: { minWidth: 36, minHeight: 44, justifyContent: 'center', marginLeft: -spacing.s2 },
  title: { flex: 1 },
  // A long title ("Gaming Tour Packages") takes a second line rather than being cut off with an ellipsis.
  titleText: { fontSize: 16, lineHeight: 20 },
  right: { minWidth: 44, alignItems: 'flex-end' },
});
