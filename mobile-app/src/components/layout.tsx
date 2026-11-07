import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { FlatList, Pressable, StyleSheet, View, type ListRenderItem } from 'react-native';

import { colors, minTouchTarget, radius, spacing } from '@/theme';

import { Text } from './Text';

/** A section title with an optional "See all" link on the right. */
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
          <Text variant="eyebrow" color="goldInk">
            {eyebrow}
          </Text>
        ) : null}
        <Text variant="h2" color="navy800" accessibilityRole="header">
          {title}
        </Text>
      </View>
      {actionLabel && onAction ? (
        <Pressable
          onPress={onAction}
          accessibilityRole="link"
          accessibilityLabel={`${actionLabel}: ${title}`}
          hitSlop={8}
          style={styles.action}
        >
          <Text variant="bodyStrong" color="goldInk">
            {actionLabel}
          </Text>
          <Ionicons name="arrow-forward" size={16} color={colors.goldInk} />
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
      style={[styles.chip, selected && styles.chipSelected]}
    >
      {icon ? <Ionicons name={icon} size={16} color={selected ? colors.white : colors.navy800} /> : null}
      <Text variant="bodyStrong" color={selected ? 'white' : 'navy800'} chrome numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A non-interactive label, for facts that are not controls (an area, a tag). */
export function Tag({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'success' | 'gold' }) {
  return (
    <View style={[styles.tag, tone === 'success' && styles.tagSuccess, tone === 'gold' && styles.tagGold]}>
      <Text variant="caption" color={tone === 'success' ? 'success' : tone === 'gold' ? 'goldInk' : 'ink2'} chrome>
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
  sectionHeader: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: spacing.s3 },
  sectionTitle: { flex: 1, gap: spacing.s1 },
  action: { flexDirection: 'row', alignItems: 'center', gap: spacing.s1, minHeight: minTouchTarget, justifyContent: 'center' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s2,
    minHeight: 44,
    paddingHorizontal: spacing.s4,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.line,
    backgroundColor: colors.white,
  },
  chipSelected: { backgroundColor: colors.navy800, borderColor: colors.navy800 },
  chipRow: { flexDirection: 'row', gap: spacing.s2 },
  tag: {
    paddingHorizontal: spacing.s3,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  tagSuccess: { backgroundColor: colors.successSoft, borderColor: colors.successSoft },
  tagGold: { backgroundColor: colors.warningSoft, borderColor: colors.warningSoft },
  // Cancel the screen's side padding so a scrolling row reaches the glass edge.
  bleed: { marginHorizontal: -spacing.s4, flexGrow: 0 },
  bleedContent: { paddingHorizontal: spacing.s4 },
  shelf: { gap: spacing.s3 },
  stars: { flexDirection: 'row', gap: 1 },
});
