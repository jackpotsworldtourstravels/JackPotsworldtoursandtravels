import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { buildMonthGrid, shiftMonth } from '@/features/search/calendar';
import { colors, fontFamily, spacing } from '@/theme';
import { WEEKDAY_LABELS, formatMonthYear, formatShortDate, nightsBetween, parseISODate, toISODate, type ISODate } from '@/utils/dates';

import { Button } from './Button';
import { Text } from './Text';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Month {
  year: number;
  month: number;
}

function monthsBetween(min: ISODate, max: ISODate): Month[] {
  const a = parseISODate(min);
  const b = parseISODate(max);
  const out: Month[] = [];
  let m = { year: a.getFullYear(), month: a.getMonth() };
  const last = b.getFullYear() * 12 + b.getMonth();
  while (m.year * 12 + m.month <= last && out.length < 15) {
    out.push(m);
    m = shiftMonth(m.year, m.month, 1);
  }
  return out;
}

export type CalendarScreenProps = {
  visible: boolean;
  title: string;
  min: ISODate;
  max: ISODate;
  onClose: () => void;
  /** Today, for the dot under it. Injectable so tests don't depend on the clock. */
  today?: ISODate;
} & (
  | {
      mode: 'single';
      value: ISODate | null;
      /** Called with the chosen day; the screen closes itself. */
      onSelect: (date: ISODate) => void;
    }
  | {
      mode: 'range';
      start: ISODate;
      end: ISODate;
      /** Which end the first tap sets. */
      initialPhase?: 'start' | 'end';
      onStart: (date: ISODate) => void;
      onEnd: (date: ISODate) => void;
      startLabel?: string;
      endLabel?: string;
    }
);

/**
 * A full-screen calendar: months scroll vertically, past and out-of-range days are disabled and announced as
 * unavailable. Single mode picks one day and closes. Range mode picks a start then an end, highlights the nights
 * between, and closes on Done; the caller applies its own rules to each pick (check-out after check-in, the
 * 30-night cap), so the calendar holds no business rules.
 */
export function CalendarScreen(props: CalendarScreenProps) {
  const { visible, title, min, max, onClose, today = toISODate(new Date()) } = props;
  const insets = useSafeAreaInsets();
  const months = useMemo(() => monthsBetween(min, max), [min, max]);
  const initialPhase = props.mode === 'range' ? (props.initialPhase ?? 'start') : 'start';
  const [phase, setPhase] = useState<'start' | 'end'>(initialPhase);
  // Each time it opens, start on the end the customer tapped (Check-in or Check-out). Set during render, not in an effect.
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) setPhase(initialPhase);
  }

  const range = props.mode === 'range' ? props : null;
  const nights = range ? nightsBetween(range.start, range.end) : 0;

  const press = (iso: ISODate) => {
    if (props.mode === 'single') {
      props.onSelect(iso);
      onClose();
      return;
    }
    if (phase === 'start' || iso <= props.start) {
      props.onStart(iso);
      setPhase('end');
    } else {
      props.onEnd(iso);
      setPhase('start');
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
      presentationStyle="fullScreen"
    >
      <View style={[styles.root, { paddingTop: insets.top }]} accessibilityViewIsModal>
        <View style={styles.top}>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={8} style={styles.close}>
            <Ionicons name="close" size={26} color={colors.ink} />
          </Pressable>
          <Text variant="h2" color="ink" accessibilityRole="header" style={styles.flex}>
            {title}
          </Text>
        </View>

        {range ? (
          <View style={styles.summary}>
            <View style={[styles.sumCell, phase === 'start' && styles.sumOn]}>
              <Text variant="label" color="textSecondary">
                {range.startLabel ?? 'Check-in'}
              </Text>
              <Text variant="h3" color="ink">
                {formatShortDate(range.start)}
              </Text>
            </View>
            <View style={[styles.sumCell, styles.sumDivider, phase === 'end' && styles.sumOn]}>
              <Text variant="label" color="textSecondary">
                {range.endLabel ?? 'Check-out'}
              </Text>
              <Text variant="h3" color="ink">
                {formatShortDate(range.end)}
              </Text>
            </View>
          </View>
        ) : null}

        <View style={styles.week} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {WEEKDAY_LABELS.map((l, i) => (
            <Text key={i} variant="caption" color="textSecondary" chrome align="center" style={styles.flex}>
              {l}
            </Text>
          ))}
        </View>

        <FlatList
          data={months}
          keyExtractor={(m) => `${m.year}-${m.month}`}
          initialNumToRender={3}
          windowSize={5}
          contentContainerStyle={{ paddingBottom: spacing.s6 }}
          renderItem={({ item }) => (
            <MonthGrid
              month={item}
              min={min}
              max={max}
              today={today}
              selectedSingle={props.mode === 'single' ? props.value : null}
              start={range?.start ?? null}
              end={range?.end ?? null}
              onPress={press}
            />
          )}
        />

        {range ? (
          <View style={[styles.footer, { paddingBottom: spacing.s3 + insets.bottom }]}>
            <View style={styles.flex}>
              <Text variant="h3" color="ink">
                {nights} night{nights === 1 ? '' : 's'}
              </Text>
              <Text variant="caption" color="textSecondary">
                {phase === 'end' ? `Now choose ${(range.endLabel ?? 'check-out').toLowerCase()}` : `${formatShortDate(range.start)} → ${formatShortDate(range.end)}`}
              </Text>
            </View>
            <Button title="Done" onPress={onClose} fullWidth={false} caps />
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

function MonthGrid({
  month,
  min,
  max,
  today,
  selectedSingle,
  start,
  end,
  onPress,
}: {
  month: Month;
  min: ISODate;
  max: ISODate;
  today: ISODate;
  selectedSingle: ISODate | null;
  start: ISODate | null;
  end: ISODate | null;
  onPress: (iso: ISODate) => void;
}) {
  const weeks = useMemo(() => buildMonthGrid(month.year, month.month), [month.year, month.month]);
  const monthName = formatMonthYear(month.year, month.month);
  return (
    <View style={styles.month}>
      <Text variant="h3" color="ink" accessibilityRole="header" style={styles.monthTitle}>
        {monthName}
      </Text>
      {weeks.map((week, w) => (
        <View key={w} style={styles.row}>
          {week.map((day, d) => {
            if (day === null) return <View key={d} style={styles.cell} />;
            const iso = toISODate(new Date(month.year, month.month, day, 12));
            const disabled = iso < min || iso > max;
            const isStart = iso === start || iso === selectedSingle;
            const isEnd = iso === end;
            const between = start !== null && end !== null && iso > start && iso < end;
            const selected = isStart || isEnd;
            return (
              <Pressable
                key={d}
                disabled={disabled}
                onPress={() => onPress(iso)}
                accessibilityRole="button"
                accessibilityLabel={`${WEEKDAY_NAMES[d]} ${day} ${monthName}${iso === today ? ', today' : ''}`}
                accessibilityState={{ disabled, selected }}
                style={[
                  styles.cell,
                  between && styles.between,
                  isStart && end !== null && end !== start && styles.startHalf,
                  isEnd && start !== null && styles.endHalf,
                ]}
              >
                <View style={[styles.day, selected && styles.daySelected]}>
                  <Text variant="bodyStrong" chrome color={selected ? 'white' : disabled ? 'textDisabled' : 'ink'}>
                    {day}
                  </Text>
                </View>
                {iso === today && !selected ? <View style={styles.todayDot} /> : null}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  flex: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2, minHeight: 52, paddingHorizontal: spacing.s4 },
  close: { width: 40, height: 44, justifyContent: 'center', marginLeft: -spacing.s1 },
  summary: { flexDirection: 'row', marginHorizontal: spacing.s4, marginBottom: spacing.s2, borderRadius: 12, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  sumCell: { flex: 1, paddingVertical: spacing.s2, paddingHorizontal: spacing.s3, gap: 2, borderBottomWidth: 3, borderBottomColor: 'transparent' },
  sumDivider: { borderLeftWidth: 1, borderLeftColor: colors.line },
  sumOn: { borderBottomColor: colors.navy900 },
  week: { flexDirection: 'row', paddingHorizontal: spacing.s3, paddingVertical: spacing.s2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  month: { paddingHorizontal: spacing.s3, paddingTop: spacing.s4 },
  monthTitle: { paddingHorizontal: spacing.s2, paddingBottom: spacing.s2, fontFamily: fontFamily.sansExtraBold },
  row: { flexDirection: 'row' },
  cell: { flex: 1, height: 46, alignItems: 'center', justifyContent: 'center' },
  between: { backgroundColor: colors.sand },
  // Half-cell bands join the start and end circles to the nights between them.
  startHalf: { backgroundColor: colors.sand, borderTopLeftRadius: 23, borderBottomLeftRadius: 23 },
  endHalf: { backgroundColor: colors.sand, borderTopRightRadius: 23, borderBottomRightRadius: 23 },
  day: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  daySelected: { backgroundColor: colors.navy900 },
  todayDot: { position: 'absolute', bottom: 4, width: 4, height: 4, borderRadius: 2, backgroundColor: colors.coral },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
    paddingTop: spacing.s3,
    paddingHorizontal: spacing.s4,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
});
