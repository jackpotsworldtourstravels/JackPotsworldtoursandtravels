/**
 * THE APP'S COMPONENT LIBRARY (UI overhaul). Presentational only: every component takes data and callbacks and
 * owns no business rules. Patterns follow a native travel-booking app (header band + overlapping card, service
 * tiles, big field cards with a swap button, segmented controls, sticky sort/filter bar, sticky price footer,
 * sticky tabs, accordions, status pills), in JackPots' palette:
 *   navy band and selected states · ivory page · white cards · coral primary action · supporting-navy links ·
 *   gold only as a highlight (gold ground with navy text, or gold on navy; never gold text on a light ground).
 */
import { Ionicons } from '@expo/vector-icons';
import { Children, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fontFamily, minTouchTarget, radius, shadow, spacing } from '@/theme';
import { formatMoney } from '@/utils/money';

import { Button } from './Button';
import { Text } from './Text';

type IconName = keyof typeof Ionicons.glyphMap;

/* ------------------------------------------------------------------ selection */

/** Two to four equal options in a pill track; the selected one is navy with a white label. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  accessibilityLabel?: string;
}) {
  return (
    <View style={styles.seg} accessibilityRole="tablist" accessibilityLabel={accessibilityLabel}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={o.label}
            style={({ pressed }) => [styles.segItem, selected && styles.segOn, pressed && !selected && styles.dim]}
          >
            <Text variant="small" color={selected ? 'white' : 'ink2'} chrome numberOfLines={1} style={selected ? styles.segLabelOn : styles.segLabel}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** One of the Home service tiles (Flights · Hotels · Holiday Packages): equal width, one icon size, one label. */
export function ServiceTile({ icon, label, onPress, divider = false }: { icon: IconName; label: string; onPress: () => void; divider?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.tile, divider && styles.tileDivider, pressed && styles.dim]}
    >
      <View style={styles.tileIcon}>
        <Ionicons name={icon} size={28} color={colors.gold} />
      </View>
      <Text variant="bodyStrong" color="ink" align="center" chrome numberOfLines={2} style={styles.tileLabel}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A smaller shortcut (My Bookings, Wishlist…): a line icon in a soft square and a short label. */
export function ShortcutTile({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.shortcut, pressed && styles.dim]}>
      <View style={styles.shortcutIcon}>
        <Ionicons name={icon} size={22} color={colors.link} />
      </View>
      <Text variant="caption" color="ink2" align="center" chrome numberOfLines={2} style={styles.shortcutLabel}>
        {label}
      </Text>
    </Pressable>
  );
}

/* ------------------------------------------------------------------ field cards */

/**
 * A tappable field: a small upper-case label, a large bold value and a muted line under it. Opens a picker or a
 * sheet; it never takes typing itself. The accessible name is "Label: value".
 */
export function FieldCard({
  label,
  value,
  sub,
  placeholder,
  onPress,
  size = 'md',
  testID,
  style,
  accessibilityLabel,
}: {
  label: string;
  value?: string;
  sub?: string;
  placeholder?: string;
  onPress: () => void;
  /** `lg` for airport codes (28 ExtraBold), `md` for dates and counts (20 ExtraBold). */
  size?: 'lg' | 'md';
  testID?: string;
  style?: StyleProp<ViewStyle>;
  /** When the spoken name should be fuller than the big value ("From Airport: Hyderabad (HYD)" for "HYD"). */
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? `${label}: ${value ?? placeholder ?? 'not set'}`}
      accessibilityHint="Opens a picker"
      style={({ pressed }) => [styles.field, pressed && styles.fieldPressed, style]}
    >
      <Text variant="label" color="textSecondary" chrome numberOfLines={1}>
        {label}
      </Text>
      <Text
        variant={size === 'lg' ? 'hero' : 'h1'}
        color={value ? 'ink' : 'textDisabled'}
        numberOfLines={1}
        style={size === 'lg' ? styles.fieldValueLg : styles.fieldValueMd}
      >
        {value ?? placeholder}
      </Text>
      {sub ? (
        <Text variant="caption" color="textSecondary" numberOfLines={1}>
          {sub}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** Field cards side by side, divided by a hairline, inside one card. */
export function FieldSplit({ children }: { children: ReactNode }) {
  const items = Children.toArray(children);
  return (
    <View style={styles.split}>
      {items.map((child, i) => (
        <View key={i} style={[styles.splitCell, i > 0 && styles.splitDivider]}>
          {child}
        </View>
      ))}
    </View>
  );
}

/** A hairline between stacked field cards. */
export function FieldDivider({ inset = true }: { inset?: boolean }) {
  return <View style={[styles.hr, inset && styles.hrInset]} />;
}

/** From over To, with the round swap button riding the line between them. */
export function LocationPairField({ from, to, onSwap }: { from: ReactNode; to: ReactNode; onSwap: () => void }) {
  return (
    <View>
      {from}
      <FieldDivider />
      {to}
      <Pressable
        onPress={onSwap}
        accessibilityRole="button"
        accessibilityLabel="Swap origin and destination"
        hitSlop={6}
        style={({ pressed }) => [styles.swap, pressed && styles.dim]}
      >
        <Ionicons name="swap-vertical" size={20} color={colors.link} />
      </Pressable>
    </View>
  );
}

/* ------------------------------------------------------------------ money, rating, status */

/**
 * A price as the API gave it, formatted ₹ en-IN (₹1,23,456), with its unit ("per night", "per person") and an
 * optional taxes note. Never computes a price.
 */
export function PriceTag({
  amount,
  unit,
  note,
  lead,
  size = 'md',
  align = 'left',
}: {
  amount: string | number | null | undefined;
  unit?: string;
  note?: string;
  /** A word before the amount: "Starting", "from". */
  lead?: string;
  size?: 'lg' | 'md' | 'sm';
  align?: 'left' | 'right';
}) {
  return (
    <View style={align === 'right' ? styles.priceRight : undefined}>
      {lead ? (
        <Text variant="caption" color="textSecondary" chrome>
          {lead}
        </Text>
      ) : null}
      <Text variant={size === 'lg' ? 'h1' : size === 'md' ? 'h2' : 'h3'} color="ink" style={styles.priceAmount} accessibilityLabel={`${lead ? `${lead} ` : ''}${formatMoney(amount)}${unit ? ` ${unit}` : ''}`}>
        {formatMoney(amount)}
        {unit ? (
          <Text variant="caption" color="textSecondary">
            {' '}
            {unit}
          </Text>
        ) : null}
      </Text>
      {note ? (
        <Text variant="caption" color="textSecondary" chrome>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

/** A rating chip. Renders nothing without a real rating, so a missing score never becomes a fake one. */
export function RatingBadge({ value, label }: { value: string | number | null | undefined; label?: string }) {
  if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return null;
  const n = Number(value);
  return (
    <View style={styles.rating} accessible accessibilityLabel={`Rated ${n.toFixed(1)} out of 5${label ? `, ${label}` : ''}`}>
      <Ionicons name="star" size={11} color={colors.white} />
      <Text variant="caption" color="white" chrome style={styles.ratingText}>
        {n.toFixed(1)}
      </Text>
    </View>
  );
}

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'navy';

const STATUS: Record<StatusTone, { bg: string; fg: 'success' | 'warning' | 'danger' | 'info' | 'ink2' | 'white' }> = {
  success: { bg: colors.successSoft, fg: 'success' },
  warning: { bg: colors.warningSoft, fg: 'warning' },
  danger: { bg: colors.dangerSoft, fg: 'danger' },
  info: { bg: colors.infoSoft, fg: 'info' },
  neutral: { bg: colors.sand, fg: 'ink2' },
  navy: { bg: colors.navy900, fg: 'white' },
};

/** A booking or payment status as a coloured pill with an icon. */
export function StatusPill({ label, tone, icon }: { label: string; tone: StatusTone; icon?: IconName }) {
  const s = STATUS[tone];
  return (
    <View style={[styles.pill, { backgroundColor: s.bg }]}>
      {icon ? <Ionicons name={icon} size={13} color={colors[s.fg]} /> : null}
      <Text variant="caption" color={s.fg} chrome style={styles.pillText}>
        {label}
      </Text>
    </View>
  );
}

/** A premium highlight ("Breakfast included", "3N / 4D"): gold ground, navy text. */
export function GoldBadge({ label }: { label: string }) {
  return (
    <View style={styles.goldBadge}>
      <Text variant="caption" color="navy900" chrome style={styles.pillText}>
        {label}
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------------ sticky bars */

/**
 * The sticky price + action bar at the bottom of a detail or checkout screen. Pass it as `Screen`'s `footer`.
 * It clears the bottom safe area itself.
 */
export function StickyFooter({
  children,
  actionTitle,
  onAction,
  actionIcon,
  loading,
  disabled,
  secondary,
  caps = false,
}: {
  /** The left side: usually a PriceTag. */
  children?: ReactNode;
  actionTitle: string;
  onAction: () => void;
  actionIcon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  /** An extra control before the primary action (an "Enquire" outline button). */
  secondary?: ReactNode;
  caps?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.footer, { paddingBottom: spacing.s3 + insets.bottom, paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right }]}>
      <View style={styles.footerLeft}>{children}</View>
      {secondary}
      <Button title={actionTitle} icon={actionIcon} onPress={onAction} loading={loading} disabled={disabled} fullWidth={false} caps={caps} />
    </View>
  );
}

export interface SortFilterAction {
  key: string;
  label: string;
  icon: IconName;
  onPress: () => void;
  /** How many filters are on; shown as a gold count. */
  count?: number;
}

/** The floating Sort · Filter · … bar over a results list. Pass it as `Screen`'s `footer`. */
export function SortFilterBar({ actions }: { actions: SortFilterAction[] }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.sfWrap, { paddingBottom: spacing.s3 + insets.bottom }]} pointerEvents="box-none">
      <View style={styles.sf}>
        {actions.map((a, i) => (
          <Pressable
            key={a.key}
            onPress={a.onPress}
            accessibilityRole="button"
            accessibilityLabel={a.count ? `${a.label}, ${a.count} on` : a.label}
            style={({ pressed }) => [styles.sfItem, i > 0 && styles.sfDivider, pressed && styles.dim]}
          >
            <Ionicons name={a.icon} size={18} color={colors.white} />
            <Text variant="bodyStrong" color="white" chrome>
              {a.label}
            </Text>
            {a.count ? (
              <View style={styles.sfCount}>
                <Text variant="caption" color="navy900" chrome style={styles.sfCountText}>
                  {a.count}
                </Text>
              </View>
            ) : null}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ in-page structure */

/**
 * In-page tabs (Overview · Rooms · Amenities …). Make it sticky by putting it in a ScrollView's
 * `stickyHeaderIndices`. Scrolls sideways when the labels outgrow the screen.
 */
export function StickyTabs<T extends string>({ tabs, value, onChange }: { tabs: readonly { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return (
    <View style={styles.tabsBar}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabsRow} accessibilityRole="tablist">
        {tabs.map((t) => {
          const selected = t.value === value;
          return (
            <Pressable key={t.value} onPress={() => onChange(t.value)} accessibilityRole="tab" accessibilityState={{ selected }} accessibilityLabel={t.label} style={styles.tab}>
              <Text variant="bodyStrong" color={selected ? 'navy900' : 'textSecondary'} chrome style={selected ? styles.tabOn : undefined}>
                {t.label}
              </Text>
              <View style={[styles.tabBar, selected && styles.tabBarOn]} />
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** A row that opens to show more (a policy, a day of an itinerary). */
export function Accordion({ title, children, initiallyOpen = false, last = false }: { title: string; children: ReactNode; initiallyOpen?: boolean; last?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View style={[styles.acc, !last && styles.accDivider]}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={title}
        style={({ pressed }) => [styles.accHead, pressed && styles.dim]}
      >
        <Text variant="bodyStrong" color="ink" style={styles.flex}>
          {title}
        </Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textSecondary} />
      </Pressable>
      {open ? <View style={styles.accBody}>{children}</View> : null}
    </View>
  );
}

/** Review → Travellers → Payment. Done steps are ticked; the current one is navy. */
export function StepIndicator({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <View style={styles.steps} accessible accessibilityLabel={`Step ${current + 1} of ${steps.length}: ${steps[current]}`}>
      {steps.map((s, i) => {
        const done = i < current;
        const on = i === current;
        return (
          <View key={s} style={[styles.step, i < steps.length - 1 && styles.flex]}>
            <View style={[styles.stepDot, done && styles.stepDone, on && styles.stepOn]}>
              {done ? (
                <Ionicons name="checkmark" size={13} color={colors.white} />
              ) : (
                <Text variant="caption" color={on ? 'white' : 'textSecondary'} chrome style={styles.stepNum}>
                  {i + 1}
                </Text>
              )}
            </View>
            <Text variant="caption" color={on ? 'ink' : done ? 'success' : 'textSecondary'} chrome style={on ? styles.stepLabelOn : undefined}>
              {s}
            </Text>
            {i < steps.length - 1 ? <View style={styles.stepLine} /> : null}
          </View>
        );
      })}
    </View>
  );
}

/** A card-level section: title row (with an optional right-hand slot) and its content. */
export function Section({ title, right, children, style }: { title?: string; right?: ReactNode; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.section, style]}>
      {title || right ? (
        <View style={styles.sectionHead}>
          {title ? (
            <Text variant="h3" color="ink" accessibilityRole="header" style={styles.flex}>
              {title}
            </Text>
          ) : (
            <View style={styles.flex} />
          )}
          {right}
        </View>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  dim: { opacity: 0.7 },

  seg: { flexDirection: 'row', backgroundColor: colors.sand, borderRadius: radius.pill, padding: 3 },
  segItem: { flex: 1, minHeight: 38, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.s2 },
  segOn: { backgroundColor: colors.navy900 },
  segLabel: { fontFamily: fontFamily.sansSemiBold },
  segLabelOn: { fontFamily: fontFamily.sansBold },

  tile: { flex: 1, alignItems: 'center', gap: spacing.s2, paddingVertical: spacing.s4, paddingHorizontal: spacing.s1, minHeight: 112 },
  tileDivider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line },
  tileIcon: { width: 56, height: 56, borderRadius: radius.lg, backgroundColor: colors.navy900, alignItems: 'center', justifyContent: 'center' },
  tileLabel: { fontFamily: fontFamily.sansBold, fontSize: 13, lineHeight: 17 },

  shortcut: { flex: 1, alignItems: 'center', gap: 6, paddingVertical: spacing.s3, minHeight: minTouchTarget },
  shortcutIcon: { width: 44, height: 44, borderRadius: radius.md, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  shortcutLabel: { fontFamily: fontFamily.sansSemiBold, fontSize: 11.5, lineHeight: 14 },

  field: { paddingVertical: spacing.s3, paddingHorizontal: spacing.s4, gap: 2, minHeight: minTouchTarget },
  fieldPressed: { backgroundColor: colors.bg },
  fieldValueLg: { letterSpacing: 0.3 },
  fieldValueMd: { fontFamily: fontFamily.sansExtraBold },
  split: { flexDirection: 'row' },
  splitCell: { flex: 1, minWidth: 0 },
  splitDivider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  hrInset: { marginHorizontal: spacing.s4 },
  swap: {
    position: 'absolute',
    right: spacing.s4,
    top: '50%',
    marginTop: -21,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },

  priceRight: { alignItems: 'flex-end' },
  priceAmount: { fontFamily: fontFamily.sansExtraBold },
  rating: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 22, paddingHorizontal: 7, borderRadius: 6, backgroundColor: colors.success, alignSelf: 'flex-start' },
  ratingText: { fontFamily: fontFamily.sansBold },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 24, paddingHorizontal: 10, borderRadius: radius.pill, alignSelf: 'flex-start' },
  pillText: { fontFamily: fontFamily.sansBold, fontSize: 11.5 },
  goldBadge: { height: 22, paddingHorizontal: 8, borderRadius: 6, backgroundColor: colors.gold, justifyContent: 'center', alignSelf: 'flex-start' },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
    paddingTop: spacing.s3,
    backgroundColor: colors.surface,
    shadowColor: colors.navy900,
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 8,
  },
  footerLeft: { flex: 1, minWidth: 0 },

  sfWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: spacing.s3 },
  sf: { flexDirection: 'row', alignItems: 'center', height: 52, borderRadius: radius.pill, backgroundColor: colors.navy900, ...shadow.md },
  sfItem: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 52 },
  sfDivider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: 'rgba(255,255,255,0.22)' },
  sfCount: { minWidth: 18, height: 18, borderRadius: 9, backgroundColor: colors.gold, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  sfCountText: { fontFamily: fontFamily.sansExtraBold, fontSize: 10.5, lineHeight: 13 },

  tabsBar: { backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  tabsRow: { paddingHorizontal: spacing.s4, gap: spacing.s5 },
  tab: { paddingTop: spacing.s3, minHeight: 46, justifyContent: 'space-between' },
  tabOn: { fontFamily: fontFamily.sansBold },
  tabBar: { height: 3, borderTopLeftRadius: 3, borderTopRightRadius: 3, marginTop: spacing.s2, backgroundColor: 'transparent' },
  tabBarOn: { backgroundColor: colors.navy900 },

  acc: {},
  accDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  accHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, minHeight: 52 },
  accBody: { paddingBottom: spacing.s4, gap: spacing.s2 },

  steps: { flexDirection: 'row', alignItems: 'center' },
  step: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepDot: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  stepDone: { backgroundColor: colors.success, borderColor: colors.success },
  stepOn: { backgroundColor: colors.navy900, borderColor: colors.navy900 },
  stepNum: { fontFamily: fontFamily.sansExtraBold, fontSize: 11 },
  stepLabelOn: { fontFamily: fontFamily.sansBold },
  stepLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginHorizontal: spacing.s2 },

  section: { gap: spacing.s3 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3 },
});
