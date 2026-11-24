import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button, Card, Checkbox, Screen, Text, TextField } from '@/components';
import { emptyAssistance, passengerName, tripDraft, useTripDraft, type AssistanceDraft, type Wheelchair } from '@/features/flights/preview/draft';
import { NoTrip, PassengerTabs } from '@/features/flights/preview/ui';
import { colors, fontFamily, spacing } from '@/theme';

/** The three wheelchair levels airlines use (WCHR, WCHS, WCHC), in plain words. */
const LEVELS: { value: Exclude<Wheelchair, null>; label: string }[] = [
  { value: 'distance', label: 'Can walk to the seat, but not long distances' },
  { value: 'steps', label: 'Can’t manage steps, can walk inside the cabin' },
  { value: 'full', label: 'Needs help all the way to the seat' },
];

/**
 * SPECIAL ASSISTANCE. Free, per traveller, sent to the airline with the booking. Medical equipment needs the airline's
 * clearance, so that one says our team will call.
 */
export default function FlightAssistanceScreen() {
  const router = useRouter();
  const draft = useTripDraft();
  const [active, setActive] = useState(0);
  if (!draft.search || draft.passengers.length === 0) {
    return (
      <Screen header={{ title: 'Special assistance', back: true, tone: 'light' }}>
        <NoTrip />
      </Screen>
    );
  }
  const a = draft.assistance[active] ?? emptyAssistance();
  const name = passengerName(draft.passengers[active], active, draft.passengers);
  const update = (change: Partial<AssistanceDraft>) =>
    tripDraft.set((s) => ({ assistance: { ...s.assistance, [active]: { ...(s.assistance[active] ?? emptyAssistance()), ...change } } }));
  const any = (x: AssistanceDraft | undefined) => Boolean(x && (x.wheelchair || x.ownMobilityAid || x.visionOrHearing || x.medical || x.infant || x.notes.trim()));

  return (
    <Screen header={{ title: 'Special assistance', subtitle: 'Free · arranged with the airline', back: true, tone: 'light' }} scroll keyboard>
      <PassengerTabs
        people={draft.passengers.map((p, i) => ({ index: i, name: passengerName(p, i, draft.passengers), status: any(draft.assistance[i]) ? 'Request saved' : 'Nothing needed', done: any(draft.assistance[i]) }))}
        active={active}
        onChange={setActive}
      />
      <Card style={[styles.card, a.wheelchair && styles.cardOn]}>
        <Checkbox label="Wheelchair: help through the airport and onto the aircraft" checked={a.wheelchair !== null} onChange={(on) => update({ wheelchair: on ? 'steps' : null })} />
        {a.wheelchair ? (
          <View style={styles.levels} accessibilityRole="radiogroup" accessibilityLabel={`How much help does ${name} need?`}>
            <Text variant="small" chrome color="ink2" style={styles.bold}>
              How much help does {name.split(' ')[0]} need?
            </Text>
            {LEVELS.map((l) => {
              const on = a.wheelchair === l.value;
              return (
                <Pressable key={l.value} onPress={() => update({ wheelchair: l.value })} accessibilityRole="radio" accessibilityState={{ checked: on }} style={[styles.level, on && styles.levelOn]}>
                  <View style={[styles.radio, on && styles.radioOn]}>{on ? <View style={styles.radioDot} /> : null}</View>
                  <Text variant="small" color="ink" style={[styles.flex, on && styles.bold]}>
                    {l.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </Card>
      <Card style={styles.card}>
        <Checkbox label="Bringing my own wheelchair or mobility aid (carried free)" checked={a.ownMobilityAid} onChange={(v) => update({ ownMobilityAid: v })} />
        <Checkbox label="Vision or hearing impairment: guidance at the airport and on board" checked={a.visionOrHearing} onChange={(v) => update({ visionOrHearing: v })} />
        <Checkbox label="Medical condition or equipment, such as oxygen (needs airline clearance; we’ll call you)" checked={a.medical} onChange={(v) => update({ medical: v })} />
        <Checkbox label="Travelling with an infant: ask for a bassinet seat" checked={a.infant} onChange={(v) => update({ infant: v })} />
      </Card>
      <TextField label="Anything else the airline should know? (optional)" value={a.notes} onChangeText={(v) => update({ notes: v })} multiline maxLength={300} />
      <Button title="Save request" onPress={() => router.back()} />
      <Text variant="small" color="textSecondary" align="center">
        We send this to the airline with the booking and confirm it by email.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  bold: { fontFamily: fontFamily.sansBold },
  card: { gap: spacing.s2 },
  cardOn: { borderWidth: 2, borderColor: colors.gold, backgroundColor: '#FFFCF4' },
  levels: { gap: spacing.s2, paddingLeft: spacing.s2 },
  level: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.divider, backgroundColor: colors.surface, paddingHorizontal: spacing.s3 },
  levelOn: { borderWidth: 1.5, borderColor: colors.primary },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.textDisabled, alignItems: 'center', justifyContent: 'center' },
  radioOn: { borderColor: colors.primary },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary },
});
