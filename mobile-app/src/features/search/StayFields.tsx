import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { CalendarScreen } from '@/components/CalendarScreen';
import { Text } from '@/components/Text';
import { DatePickerField, FieldRow, GuestsField, dayMonth, weekdayYear } from '@/components/pickers';
import { FieldCard, FieldDivider, FieldSplit } from '@/components/ui';
import { colors, fontFamily, radius, spacing } from '@/theme';
import { addDays, formatShortDate, nightsBetween, todayISO } from '@/utils/dates';

import type { Party } from './party';
import { maxDate, setCheckIn, setCheckOut, type StayDates } from './stay';

/**
 * Check-in, check-out and guests: the three fields a hotel stay is made of,
 * shared by the hotel search and the hotel page so they can never disagree about
 * the rules (check-out stays after check-in, nothing in the past, a year ahead
 * at most, party limits the booking call accepts).
 *
 * `card` (the search form) shows the two dates side by side as field cards with the nights between them; both
 * open one range calendar. `tile` is the compact version for forms inside a page.
 */
export function StayFields({
  stay,
  onStayChange,
  party,
  onPartyChange,
  appearance = 'tile',
}: {
  stay: StayDates;
  onStayChange: (stay: StayDates) => void;
  party: Party;
  onPartyChange: (party: Party) => void;
  appearance?: 'tile' | 'card';
}) {
  const today = todayISO();
  const max = useMemo(() => maxDate(), []);
  const nights = nightsBetween(stay.checkIn, stay.checkOut);
  const [calendar, setCalendar] = useState<'start' | 'end' | null>(null);

  if (appearance === 'card') {
    return (
      <>
        <View>
          <FieldSplit>
            <FieldCard label="Check-in" value={dayMonth(stay.checkIn)} sub={weekdayYear(stay.checkIn)} accessibilityLabel={`Check-in: ${formatShortDate(stay.checkIn)}`} onPress={() => setCalendar('start')} />
            <FieldCard label="Check-out" value={dayMonth(stay.checkOut)} sub={weekdayYear(stay.checkOut)} accessibilityLabel={`Check-out: ${formatShortDate(stay.checkOut)}`} onPress={() => setCalendar('end')} />
          </FieldSplit>
          <View style={styles.nights} pointerEvents="none">
            <Text variant="caption" color="white" chrome style={styles.nightsText}>
              {nights} Night{nights === 1 ? '' : 's'}
            </Text>
          </View>
        </View>
        <FieldDivider inset={false} />
        <GuestsField value={party} onChange={onPartyChange} appearance="card" />
        <CalendarScreen
          mode="range"
          visible={calendar !== null}
          title="Select dates"
          start={stay.checkIn}
          end={stay.checkOut}
          initialPhase={calendar ?? 'start'}
          min={today}
          max={addDays(max, 1)}
          onStart={(d) => onStayChange(setCheckIn(stay, d))}
          onEnd={(d) => onStayChange(setCheckOut(stay, d))}
          onClose={() => setCalendar(null)}
        />
      </>
    );
  }

  return (
    <>
      <FieldRow>
        <DatePickerField
          label="Check-in"
          value={stay.checkIn}
          min={today}
          max={max}
          onChange={(d) => onStayChange(setCheckIn(stay, d))}
        />
        <DatePickerField
          label="Check-out"
          value={stay.checkOut}
          min={addDays(stay.checkIn, 1)}
          max={addDays(max, 1)}
          onChange={(d) => onStayChange(setCheckOut(stay, d))}
        />
      </FieldRow>
      <Text variant="small" color="textSecondary" align="center" style={styles.nightsLine}>
        {nights} night{nights === 1 ? '' : 's'}
      </Text>
      <GuestsField value={party} onChange={onPartyChange} />
    </>
  );
}

const styles = StyleSheet.create({
  nightsLine: { marginVertical: -4 },
  // The nights count rides the bottom edge of the date pair, centred on the divider between them.
  nights: { position: 'absolute', bottom: -11, left: 0, right: 0, alignItems: 'center', zIndex: 2 },
  nightsText: { backgroundColor: colors.navy900, overflow: 'hidden', paddingHorizontal: spacing.s3, paddingVertical: 3, borderRadius: radius.pill, fontFamily: fontFamily.sansBold },
});
