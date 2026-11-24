import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, shadow, spacing } from '@/theme';

import { StickyTabs } from './ui';

export interface DetailSection<K extends string> {
  key: K;
  label: string;
  content: ReactNode;
}

/**
 * A detail page (hotel, package): a full-bleed photo with floating back and action buttons over it, a title block,
 * then sticky in-page tabs that jump to each section and follow the scroll. Every section stays on the page, so
 * nothing is hidden behind a tab.
 */
export function DetailScroll<K extends string>({
  media,
  title,
  sections,
  actions,
  jumpRequest,
}: {
  media: ReactNode;
  title: ReactNode;
  sections: DetailSection<K>[];
  /** Round buttons at the top right of the photo (wishlist, share). */
  actions?: ReactNode;
  /** Scroll to a section from outside (the footer's "Select room"); bump `seq` to repeat. */
  jumpRequest?: { key: K; seq: number };
}) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const offsets = useRef<Partial<Record<K, number>>>({});
  const tabsHeight = useRef(46);
  const [active, setActive] = useState<K>(sections[0]?.key as K);

  const scrollToSection = (key: K) => {
    const y = offsets.current[key];
    if (y !== undefined) scroll.current?.scrollTo({ y: Math.max(0, y - tabsHeight.current - insets.top), animated: true });
  };
  const jump = (key: K) => {
    setActive(key);
    scrollToSection(key);
  };

  // A jump request from outside: the tab is marked during render, then the effect scrolls.
  const seq = jumpRequest?.seq ?? 0;
  const [handledSeq, setHandledSeq] = useState(seq);
  if (seq !== handledSeq) {
    setHandledSeq(seq);
    if (seq > 0 && jumpRequest) setActive(jumpRequest.key);
  }
  useEffect(() => {
    if (seq > 0 && jumpRequest) scrollToSection(jumpRequest.key);
    // Only a new request should scroll; `scrollToSection` is recreated each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y + tabsHeight.current + insets.top + 8;
    let current = sections[0]?.key as K;
    for (const s of sections) {
      const top = offsets.current[s.key];
      if (top !== undefined && top <= y) current = s.key;
    }
    if (current !== active) setActive(current);
  };

  return (
    <View style={styles.root}>
      <ScrollView ref={scroll} stickyHeaderIndices={[2]} onScroll={onScroll} scrollEventThrottle={64} contentContainerStyle={styles.content}>
        <View>{media}</View>
        <View style={styles.titleBlock}>{title}</View>
        <View onLayout={(e: LayoutChangeEvent) => (tabsHeight.current = e.nativeEvent.layout.height)} style={{ paddingTop: 0 }}>
          <StickyTabs tabs={sections.map((s) => ({ value: s.key, label: s.label }))} value={active} onChange={jump} />
        </View>
        {sections.map((s) => (
          <View key={s.key} onLayout={(e: LayoutChangeEvent) => (offsets.current[s.key] = e.nativeEvent.layout.y)} style={styles.section}>
            {s.content}
          </View>
        ))}
      </ScrollView>
      <View style={[styles.topBar, { top: insets.top + spacing.s2, left: spacing.s4 + insets.left, right: spacing.s4 + insets.right }]} pointerEvents="box-none">
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={6}
          style={({ pressed }) => [styles.round, pressed && styles.pressed]}
        >
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <View style={styles.actions}>{actions}</View>
      </View>
    </View>
  );
}

/** A round white button for the top of a photo. */
export function PhotoAction({ icon, label, onPress, active = false }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void; active?: boolean }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={6} style={({ pressed }) => [styles.round, pressed && styles.pressed]}>
      <Ionicons name={icon} size={20} color={active ? colors.coral : colors.ink} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { paddingBottom: spacing.s6 },
  titleBlock: { backgroundColor: colors.surface, paddingHorizontal: spacing.s4, paddingTop: spacing.s4, paddingBottom: spacing.s3, gap: spacing.s2 },
  section: { paddingHorizontal: spacing.s4, paddingTop: spacing.s5, gap: spacing.s3 },
  topBar: { position: 'absolute', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  actions: { flexDirection: 'row', gap: spacing.s2 },
  round: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.95)', alignItems: 'center', justifyContent: 'center', ...shadow.sm },
  pressed: { opacity: 0.75 },
});
