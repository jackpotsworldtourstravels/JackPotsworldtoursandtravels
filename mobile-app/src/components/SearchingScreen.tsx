import { useEffect, useState } from 'react';
import { Animated, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fontFamily, spacing } from '@/theme';

import { TakeoffLoader, useLoop } from './Loader';
import { Logo } from './Logo';
import { Text } from './Text';

/** How long the searching screen stays up once shown, so a fast answer doesn't flash it on and off. */
const MIN_SEARCH_MS = process.env.NODE_ENV === 'test' ? 0 : 1200;

/**
 * Whether a search screen should still show the full-screen "searching" moment. True from the first render while
 * the first answer is on its way, and for at least MIN_SEARCH_MS once shown; false for good after that, so later
 * refreshes (a filter, a sort, pull to refresh) show the lighter skeleton instead. A screen that opens with its
 * answer already cached never shows it.
 */
export function useFirstSearch(pending: boolean): boolean {
  const [done, setDone] = useState(() => !pending);
  const [minElapsed, setMinElapsed] = useState(MIN_SEARCH_MS === 0);
  useEffect(() => {
    if (MIN_SEARCH_MS === 0) return;
    const t = setTimeout(() => setMinElapsed(true), MIN_SEARCH_MS);
    return () => clearTimeout(t);
  }, []);
  if (!done && minElapsed && !pending) setDone(true);
  return !done;
}

function Dot({ delay }: { delay: number }) {
  const t = useLoop(1200);
  // Each dot brightens in turn: a third of the loop apart.
  const opacity = t.interpolate({
    inputRange: [0, delay, delay + 0.2, Math.min(1, delay + 0.4), 1],
    outputRange: [0.25, 0.25, 1, 0.25, 0.25],
    extrapolate: 'clamp',
  });
  return <Animated.View style={[styles.dot, { opacity }]} />;
}

/**
 * THE SEARCHING SCREEN: the take-off over navy, what is being searched for in words, three pulsing dots, a way out
 * and the logo. Full screen, over the results page, while a search's first answer is on its way.
 */
export function SearchingScreen({ visible, title, subtitle, onCancel, cancelLabel = 'Cancel search' }: { visible: boolean; title: string; subtitle?: string; onCancel: () => void; cancelLabel?: string }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom + spacing.s6 }]} accessibilityViewIsModal>
        <View style={styles.glow} />
        <View style={styles.middle} accessibilityRole="progressbar" accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title} accessibilityLiveRegion="polite">
          <TakeoffLoader width={300} tone="onDark" label={title} />
          <Text variant="h2" color="white" align="center">
            {title}
          </Text>
          {subtitle ? (
            <Text variant="body" color="onDark2" align="center">
              {subtitle}
            </Text>
          ) : null}
          <View style={styles.dots} importantForAccessibility="no-hide-descendants">
            <Dot delay={0} />
            <Dot delay={0.17} />
            <Dot delay={0.34} />
          </View>
        </View>
        <View style={styles.bottom}>
          <Pressable onPress={onCancel} accessibilityRole="button" hitSlop={8} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
            <Text variant="body" chrome color="goldLight" style={styles.cancelText}>
              {cancelLabel}
            </Text>
          </Pressable>
          <Logo size={78} style={styles.logo} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.navy900, alignItems: 'center', paddingHorizontal: spacing.s6 },
  glow: { position: 'absolute', width: 460, height: 460, borderRadius: 230, top: '18%', backgroundColor: colors.navy800 },
  middle: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.s3 },
  dots: { flexDirection: 'row', gap: 6, marginTop: spacing.s2 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.gold },
  bottom: { alignItems: 'center', gap: spacing.s3 },
  cancel: { minHeight: 44, paddingHorizontal: spacing.s4, justifyContent: 'center' },
  cancelText: { fontFamily: fontFamily.sansBold },
  pressed: { opacity: 0.7 },
  logo: { opacity: 0.9 },
});
