import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Banner, Card, PriceTag, Screen, StepIndicator, StickyFooter, Text, TextField } from '@/components';
import { useTravellers } from '@/features/account/hooks';
import { TRAVELLER_TITLES } from '@/features/account/travellerForm';
import { passengerName, tripDraft, useTripDraft, type PassengerDraft } from '@/features/flights/preview/draft';
import { tripTotals } from '@/features/flights/preview/extras';
import { FLIGHT_STEPS } from '@/features/flights/preview/flow';
import { isInternational, legsOf } from '@/features/flights/preview/sample';
import { NoTrip, SampleNotice } from '@/features/flights/preview/ui';
import { useAuth } from '@/providers/AuthProvider';
import { colors, fontFamily, spacing } from '@/theme';
import type { SavedTraveller } from '@/types/account';

const KIND_AGES = { adult: '12+ years', child: '2–11 years', infant: 'Under 2, on a lap' } as const;

function missing(p: PassengerDraft, passport: boolean): string | null {
  if (!p.firstName.trim() || !p.lastName.trim()) return 'Add the first and last name, as on their ID.';
  if (passport && (!p.passportNumber.trim() || !p.passportExpiry.trim())) return 'This trip leaves India: add the passport number and expiry.';
  return null;
}

/**
 * TRAVELLER DETAILS. One card per passenger the search asked for, names exactly as on the ID they will carry. Saved
 * travellers fill a card in one tap; passports are asked for only when the trip leaves India. Then where the tickets
 * go. Nothing here is sent anywhere until the customer sends the trip to our team at the end.
 */
export default function FlightTravellersScreen() {
  const router = useRouter();
  const draft = useTripDraft();
  const { customer, status } = useAuth();
  const saved = useTravellers();
  const [open, setOpen] = useState(0);
  const [tried, setTried] = useState(false);

  const search = draft.search;
  const legs = search ? legsOf(search) : [];
  if (!search || draft.passengers.length === 0) {
    return (
      <Screen header={{ title: 'Traveller details', back: true, tone: 'light' }}>
        <NoTrip />
      </Screen>
    );
  }
  const passport = isInternational(legs);
  const email = draft.contactEmail || (status === 'customer' ? (customer?.email ?? '') : '');
  const mobile = draft.contactMobile || (status === 'customer' ? (customer?.mobile ?? '') : '');
  const problems = draft.passengers.map((p) => missing(p, passport));
  const ready = problems.every((p) => p === null) && Boolean(email.trim());
  const totals = tripTotals(draft);

  const update = (i: number, change: Partial<PassengerDraft>) =>
    tripDraft.set((s) => ({ passengers: s.passengers.map((p, j) => (j === i ? { ...p, ...change } : p)) }));

  const used = new Set(draft.passengers.map((p) => `${p.firstName} ${p.lastName}`.trim().toLowerCase()));
  const fill = (t: SavedTraveller) => {
    const kind = t.traveller_type === 'infant' ? 'infant' : t.traveller_type === 'child' ? 'child' : 'adult';
    const slot = draft.passengers.findIndex((p) => p.type === kind && !p.firstName && !p.lastName);
    if (slot < 0) return;
    update(slot, {
      title: t.title ?? '',
      firstName: t.first_name,
      middleName: t.middle_name ?? '',
      lastName: t.last_name,
      dateOfBirth: t.date_of_birth ?? '',
      nationality: t.nationality ?? 'Indian',
      passportNumber: t.passport_number ?? '',
      passportExpiry: t.passport_expiry ?? '',
      frequentFlyer: t.frequent_flyer_number ?? '',
    });
    const next = draft.passengers.findIndex((p, j) => j !== slot && !p.firstName);
    setOpen(next >= 0 ? next : -1);
  };

  const next = () => {
    setTried(true);
    if (!ready) {
      const first = problems.findIndex(Boolean);
      if (first >= 0) setOpen(first);
      return;
    }
    tripDraft.set({ contactEmail: email, contactMobile: mobile });
    router.push('/flights/book/seats');
  };

  return (
    <Screen
      header={{ title: 'Traveller details', subtitle: 'Names exactly as on the ID you’ll carry', back: true, tone: 'light' }}
      scroll
      keyboard
      footer={
        <StickyFooter actionTitle="Choose seats" onAction={next}>
          <PriceTag amount={totals.total} note={`${draft.passengers.length - problems.filter(Boolean).length} of ${draft.passengers.length} travellers ready`} size="md" />
        </StickyFooter>
      }
    >
      <StepIndicator steps={FLIGHT_STEPS} current={1} />
      <SampleNotice compact />

      {saved.data && saved.data.length > 0 ? (
        <View style={styles.saved}>
          <Text variant="small" chrome color="textSecondary" style={styles.bold}>
            From your saved travellers
          </Text>
          <View style={styles.chips}>
            {saved.data.map((t) => {
              const name = `${t.first_name} ${t.last_name}`.trim();
              const on = used.has(name.toLowerCase());
              return (
                <Pressable
                  key={t.customer_traveller_id}
                  onPress={() => (on ? undefined : fill(t))}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={on ? `${name}, added` : `Add ${name}`}
                  style={[styles.chip, on && styles.chipOn]}
                >
                  <Ionicons name={on ? 'checkmark' : 'add'} size={14} color={on ? colors.goldLight : colors.ink2} />
                  <Text variant="small" chrome color={on ? 'white' : 'ink2'} style={styles.bold}>
                    {name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      {draft.passengers.map((p, i) => {
        const expanded = open === i;
        const problem = problems[i];
        const title = `${p.type[0].toUpperCase()}${p.type.slice(1)} ${draft.passengers.slice(0, i + 1).filter((x) => x.type === p.type).length}${i === 0 ? ' · Booking contact' : ''}`;
        if (!expanded) {
          return (
            <Pressable
              key={i}
              onPress={() => setOpen(i)}
              accessibilityRole="button"
              accessibilityLabel={`${title}, ${problem ? 'not complete' : `${passengerName(p, i, draft.passengers)}, complete`}. Edit`}
              style={({ pressed }) => [styles.collapsed, tried && problem && styles.collapsedBad, pressed && styles.pressed]}
            >
              <View style={[styles.initials, !problem && styles.initialsOk]}>
                {problem ? <Ionicons name="person-outline" size={16} color={colors.textSecondary} /> : <Ionicons name="checkmark" size={16} color={colors.white} />}
              </View>
              <View style={styles.flex}>
                <Text variant="bodyStrong" color="ink">
                  {problem ? title : `${p.title ? `${p.title} ` : ''}${passengerName(p, i, draft.passengers)}`}
                </Text>
                <Text variant="caption" color={tried && problem ? 'danger' : 'textSecondary'}>
                  {problem ? (tried ? problem : KIND_AGES[p.type]) : [p.dateOfBirth && `Born ${p.dateOfBirth}`, p.nationality].filter(Boolean).join(' · ') || title}
                </Text>
              </View>
              <Text variant="small" chrome color="goldInk" style={styles.bold}>
                {problem ? 'Add' : 'Edit'}
              </Text>
            </Pressable>
          );
        }
        return (
          <Card key={i} style={[styles.card, styles.cardOpen]}>
            <View style={styles.cardHead}>
              <Text variant="h3" color="ink" accessibilityRole="header" style={styles.flex}>
                {title}
              </Text>
              <Text variant="caption" color="textSecondary">
                {KIND_AGES[p.type]}
              </Text>
            </View>
            <View style={styles.titles} accessibilityRole="radiogroup" accessibilityLabel="Title">
              {TRAVELLER_TITLES.map((t) => {
                const on = p.title === t;
                return (
                  <Pressable key={t} onPress={() => update(i, { title: on ? '' : t })} accessibilityRole="radio" accessibilityState={{ checked: on }} style={[styles.titleBtn, on && styles.titleOn]}>
                    <Text variant="small" chrome color={on ? 'ink' : 'ink2'} style={styles.bold}>
                      {t}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {/* One name per line, full width, in the order a passport prints them. */}
            <TextField label="First name" value={p.firstName} onChangeText={(v) => update(i, { firstName: v })} autoComplete="given-name" autoCapitalize="words" error={tried && !p.firstName.trim() ? 'Required' : undefined} />
            <TextField label="Middle name (optional)" value={p.middleName} onChangeText={(v) => update(i, { middleName: v })} autoComplete="additional-name" autoCapitalize="words" />
            <TextField label="Last name" value={p.lastName} onChangeText={(v) => update(i, { lastName: v })} autoComplete="family-name" autoCapitalize="words" error={tried && !p.lastName.trim() ? 'Required' : undefined} />
            <View style={styles.pair}>
              <View style={styles.flex}>
                <TextField label="Date of birth" value={p.dateOfBirth} onChangeText={(v) => update(i, { dateOfBirth: v })} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" maxLength={10} />
              </View>
              <View style={styles.flex}>
                <TextField label="Nationality" value={p.nationality} onChangeText={(v) => update(i, { nationality: v })} autoCapitalize="words" />
              </View>
            </View>
            {passport ? (
              <View style={styles.pair}>
                <View style={styles.flex}>
                  <TextField label="Passport number" value={p.passportNumber} onChangeText={(v) => update(i, { passportNumber: v.toUpperCase() })} autoCapitalize="characters" error={tried && !p.passportNumber.trim() ? 'Required' : undefined} />
                </View>
                <View style={styles.flex}>
                  <TextField label="Passport expiry" value={p.passportExpiry} onChangeText={(v) => update(i, { passportExpiry: v })} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" maxLength={10} error={tried && !p.passportExpiry.trim() ? 'Required' : undefined} />
                </View>
              </View>
            ) : null}
            {p.type !== 'infant' ? (
              <TextField label="Frequent flyer number (optional)" value={p.frequentFlyer} onChangeText={(v) => update(i, { frequentFlyer: v.toUpperCase() })} autoCapitalize="characters" />
            ) : null}
            <Pressable onPress={() => setOpen(draft.passengers.findIndex((x, j) => j > i && !x.firstName))} accessibilityRole="button" style={styles.done}>
              <Text variant="small" chrome color="link" style={styles.bold}>
                Done
              </Text>
            </Pressable>
          </Card>
        );
      })}

      <Card style={styles.card}>
        <Text variant="h3" color="ink" accessibilityRole="header">
          Where we send your tickets
        </Text>
        <TextField label="Email" value={email} onChangeText={(v) => tripDraft.set({ contactEmail: v })} keyboardType="email-address" autoCapitalize="none" error={tried && !email.trim() ? 'We need an email for your tickets' : undefined} />
        <TextField label="Mobile" value={mobile} onChangeText={(v) => tripDraft.set({ contactMobile: v })} keyboardType="phone-pad" />
      </Card>
      {tried && !ready ? <Banner tone="error" message="Some details are missing. The cards marked in red need a look." /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  bold: { fontFamily: fontFamily.sansBold },
  pressed: { opacity: 0.8 },
  saved: { gap: spacing.s2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  chip: { minHeight: 38, borderRadius: 19, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, paddingHorizontal: spacing.s3, flexDirection: 'row', alignItems: 'center', gap: 6 },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  card: { gap: spacing.s3 },
  cardOpen: { borderWidth: 1.5, borderColor: colors.primary },
  cardHead: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.s2 },
  titles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  titleBtn: { minWidth: 52, minHeight: 40, borderRadius: 12, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.s3 },
  titleOn: { borderWidth: 2, borderColor: colors.primary, backgroundColor: '#F1F4F9' },
  pair: { flexDirection: 'row', gap: spacing.s2 },
  done: { alignSelf: 'flex-end', minHeight: 40, justifyContent: 'center', paddingHorizontal: spacing.s2 },
  collapsed: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, backgroundColor: colors.surface, borderRadius: 18, borderWidth: 1, borderColor: colors.divider, padding: spacing.s3, minHeight: 64 },
  collapsedBad: { borderColor: colors.danger },
  initials: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
  initialsOk: { backgroundColor: colors.success },
});
