import { useMemo } from 'react';
import { StyleSheet } from 'react-native';

import { Text } from '@/components/Text';
import { DatePickerField, FieldRow, GuestsField } from '@/components/pickers';
import { addDays, nightsBetween, todayISO } from '@/utils/dates';

import type { Party } from './party';
import { maxDate, setCheckIn, setCheckOut, type StayDates } from './stay';

/**
 * Check-in, check-out and guests: the three fields a hotel stay is made of,
 * shared by the search card and the hotel page so they can never disagree about
 * the rules (check-out stays after check-in, nothing in the past, a year ahead
 * at most, party limits the booking call accepts).
 */
export function StayFields({
  stay,
  onStayChange,
  party,
  onPartyChange,
}: {
  stay: StayDates;
  onStayChange: (stay: StayDates) => void;
  party: Party;
  onPartyChange: (party: Party) => void;
}) {
  const today = todayISO();
  const max = useMemo(() => maxDate(), []);
  const nights = nightsBetween(stay.checkIn, stay.checkOut);

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
      <Text variant="small" color="muted" align="center" style={styles.nights}>
        {nights} night{nights === 1 ? '' : 's'}
      </Text>
      <GuestsField value={party} onChange={onPartyChange} />
    </>
  );
}

const styles = StyleSheet.create({ nights: { marginVertical: -4 } });
