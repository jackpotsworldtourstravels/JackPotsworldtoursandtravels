import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Screen } from '@/components/Screen';
import { colors, radius, shadow, spacing } from '@/theme';

/**
 * A service's search screen: the navy header band with a back arrow and the service name, the search form in a
 * white card that overlaps the band, and whatever helps the customer start (popular places, departing soon) under it.
 */
export function SearchLanding({ title, children, below }: { title: string; children: ReactNode; below?: ReactNode }) {
  const insets = useSafeAreaInsets();
  const side = { marginLeft: spacing.s3 + insets.left, marginRight: spacing.s3 + insets.right };
  return (
    <Screen header={{ title, back: true }} scroll flush keyboard>
      <View style={styles.band} />
      <View style={[styles.card, side]}>{children}</View>
      {below ? <View style={[styles.below, { paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right }]}>{below}</View> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  band: { height: 56, backgroundColor: colors.navy900 },
  card: { marginTop: -48, backgroundColor: colors.surface, borderRadius: radius.md, ...shadow.sm },
  below: { gap: spacing.s3, paddingTop: spacing.s6, paddingBottom: spacing.s6 },
});
