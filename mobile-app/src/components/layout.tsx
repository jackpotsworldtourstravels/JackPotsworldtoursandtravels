import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { FlatList, Pressable, StyleSheet, View, type ListRenderItem } from 'react-native';

import { colors, fontFamily, radius, spacing } from '@/theme';

import { Text } from './Text';

/** A section title (16 / Bold) with an optional "View All" link on the right, in the link colour. */
export function SectionHeader({
  title,
  eyebrow,
  actionLabel,
  onAction,
}: {
  title: string;
  eyebrow?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.sectionHeader}>
      <View style={styles.sectionTitle}>
        {eyebrow ? (
          <Text variant="label" color="textSecondary">
            {eyebrow}
          </Text>
        ) : null}
        <Text variant="h3" color="ink" accessibilityRole="header">
          {title}
        </Text>
      </View>
      {actionLabel && onAction ? (
        <Pressable
          onPress={onAction}
          accessibilityRole="link"
          accessibilityLabel={`${actionLabel}: ${title}`}
          hitSlop={8}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <Text variant="bodyStrong" color="link" chrome>
            {actionLabel}
          </Text>
          <Ionicons name="chevron-forward" size={16} color={colors.link} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** A selectable pill: sort options, filters, trip types. */
export function Chip({
  label,
  selected = false,
  onPress,
  icon,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}
    >
      {icon ? <Ionicons name={icon} size={15} color={selected ? colors.white : colors.ink2} /> : null}
      <Text variant="small" color={selected ? 'white' : 'ink2'} chrome numberOfLines={1} style={styles.chipLabel}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * A non-interactive label, for facts that are not controls (an area, a tag). `gold` is the premium highlight:
 * gold ground, navy text (gold is never used as text on a light ground).
 */
export function Tag({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'success' | 'gold' }) {
  return (
    <View style={[styles.tag, tone === 'success' && styles.tagSuccess, tone === 'gold' && styles.tagGold]}>
      <Text variant="caption" color={tone === 'success' ? 'success' : tone === 'gold' ? 'navy900' : 'ink2'} chrome style={styles.tagLabel}>
        {label}
      </Text>
    </View>
  );
}

/** Chips in a row that scrolls sideways rather than wrapping off a small screen. */
export function ChipRow({ children }: { children: ReactNode }) {
  return (
    <FlatList
      horizontal
      data={[0]}
      keyExtractor={() => 'chips'}
      showsHorizontalScrollIndicator={false}
      renderItem={() => <View style={styles.chipRow}>{children}</View>}
      style={styles.bleed}
      contentContainerStyle={styles.bleedContent}
    />
  );
}

/**
 * A horizontally scrolling shelf of cards that runs to the screen edges while
 * the rest of the page keeps its gutters.
 */
export function Shelf<T>({
  data,
  renderItem,
  keyExtractor,
  itemWidth,
}: {
  data: readonly T[];
  renderItem: ListRenderItem<T>;
  keyExtractor: (item: T) => string;
  /** Width of one card plus gap, so the shelf settles on a card edge. */
  itemWidth: number;
}) {
  return (
    <FlatList
      horizontal
      data={data as T[]}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      showsHorizontalScrollIndicator={false}
      snapToInterval={itemWidth + spacing.s3}
      decelerationRate="fast"
      style={styles.bleed}
      contentContainerStyle={[styles.bleedContent, styles.shelf]}
    />
  );
}

/** Rating as filled stars, with the number spelled out for screen readers. */
export function Stars({ count }: { count: number }) {
  const n = Math.max(0, Math.min(5, Math.round(count)));
  return (
    <View style={styles.stars} accessible accessibilityLabel={`${n} star hotel`}>
      {Array.from({ length: n }, (_, i) => (
        <Ionicons key={i} name="star" size={13} color={colors.gold} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.s3 },
  sectionTitle: { flex: 1, gap: 2 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 44, justifyContent: 'center' },
  pressed: { opacity: 0.7 },
  // 34px pill; the row of chips sits in a 44px band, so the touch target holds.
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  chipLabel: { fontFamily: fontFamily.sansSemiBold },
  chipSelected: { backgroundColor: colors.navy900, borderColor: colors.navy900 },
  chipRow: { flexDirection: 'row', gap: spacing.s2 },
  tag: {
    paddingHorizontal: spacing.s2,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: colors.surface2,
  },
  tagLabel: { fontFamily: fontFamily.sansBold, fontSize: 11 },
  tagSuccess: { backgroundColor: colors.successSoft },
  tagGold: { backgroundColor: colors.gold },
  // Cancel the screen's side padding so a scrolling row reaches the glass edge.
  bleed: { marginHorizontal: -spacing.s4, flexGrow: 0 },
  bleedContent: { paddingHorizontal: spacing.s4 },
  shelf: { gap: spacing.s3 },
  stars: { flexDirection: 'row', gap: 1 },
});
