import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { buildMonthGrid, shiftMonth } from '@/features/search/calendar';
import { colors, radius, spacing } from '@/theme';
import {
  WEEKDAY_LABELS,
  formatMonthYear,
  parseISODate,
  toISODate,
  type ISODate,
} from '@/utils/dates';

import { Text } from './Text';

export interface CalendarProps {
  value: ISODate;
  min: ISODate;
  max: ISODate;
  onSelect: (date: ISODate) => void;
  /** Today, for the ring around it. Injectable so tests don't depend on the clock. */
  today?: ISODate;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * A month grid for picking one date. Days outside [min, max] are disabled and
 * announced as unavailable; the arrows stop at the first and last month in range.
 * Built in JavaScript so it looks and behaves the same on Android, iOS and the
 * browser preview, and so it can be tested.
 */
export function Calendar({ value, min, max, onSelect, today = toISODate(new Date()) }: CalendarProps) {
  const start = parseISODate(value);
  const [view, setView] = useState({ year: start.getFullYear(), month: start.getMonth() });

  const minD = parseISODate(min);
  const maxD = parseISODate(max);
  const canGoBack = view.year * 12 + view.month > minD.getFullYear() * 12 + minD.getMonth();
  const canGoForward = view.year * 12 + view.month < maxD.getFullYear() * 12 + maxD.getMonth();

  const weeks = useMemo(() => buildMonthGrid(view.year, view.month), [view.year, view.month]);

  const go = (delta: number) => setView((v) => shiftMonth(v.year, v.month, delta));

  return (
    <View style={styles.wrap}>
      <View style={styles.nav}>
        <Pressable
          onPress={() => go(-1)}
          disabled={!canGoBack}
          accessibilityRole="button"
          accessibilityLabel="Previous month"
          accessibilityState={{ disabled: !canGoBack }}
          style={[styles.arrow, !canGoBack && styles.arrowOff]}
        >
          <Ionicons name="chevron-back" size={22} color={colors.navy800} />
        </Pressable>
        <Text variant="title" color="navy800" accessibilityRole="header" accessibilityLiveRegion="polite">
          {formatMonthYear(view.year, view.month)}
        </Text>
        <Pressable
          onPress={() => go(1)}
          disabled={!canGoForward}
          accessibilityRole="button"
          accessibilityLabel="Next month"
          accessibilityState={{ disabled: !canGoForward }}
          style={[styles.arrow, !canGoForward && styles.arrowOff]}
        >
          <Ionicons name="chevron-forward" size={22} color={colors.navy800} />
        </Pressable>
      </View>

      <View style={styles.row} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {WEEKDAY_LABELS.map((label, i) => (
          <View key={i} style={styles.cell}>
            <Text variant="caption" color="muted" chrome>
              {label}
            </Text>
          </View>
        ))}
      </View>

      {weeks.map((week, w) => (
        <View key={w} style={styles.row}>
          {week.map((day, d) => {
            if (day === null) return <View key={d} style={styles.cell} />;
            const iso = toISODate(new Date(view.year, view.month, day, 12));
            const disabled = iso < min || iso > max;
            const selected = iso === value;
            const isToday = iso === today;
            const weekday = WEEKDAY_NAMES[d];
            return (
              <Pressable
                key={d}
                disabled={disabled}
                onPress={() => onSelect(iso)}
                accessibilityRole="button"
                accessibilityLabel={`${weekday} ${day} ${formatMonthYear(view.year, view.month)}${isToday ? ', today' : ''}`}
                accessibilityState={{ disabled, selected }}
                style={styles.cell}
              >
                <View
                  style={[
                    styles.day,
                    selected && styles.daySelected,
                    !selected && isToday && styles.dayToday,
                    disabled && styles.dayDisabled,
                  ]}
                >
                  <Text
                    variant="bodyStrong"
                    chrome
                    color={selected ? 'white' : disabled ? 'muted' : 'ink'}
                  >
                    {day}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.s1 },
  nav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.s2 },
  arrow: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill },
  arrowOff: { opacity: 0.3 },
  row: { flexDirection: 'row' },
  cell: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 44 },
  day: { width: 40, height: 40, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  daySelected: { backgroundColor: colors.navy800 },
  dayToday: { borderWidth: 1.5, borderColor: colors.goldInk },
  dayDisabled: { opacity: 0.35 },
});
