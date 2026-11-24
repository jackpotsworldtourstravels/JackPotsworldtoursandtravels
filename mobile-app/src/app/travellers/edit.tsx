import { zodResolver } from '@hookform/resolvers/zod';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { isApiError } from '@/api/errors';
import { AuthGate, Banner, Button, Card, EmptyState, ErrorState, LoadingState, Screen, Text, TextField } from '@/components';
import { useSaveTraveller, useTravellers } from '@/features/account/hooks';
import {
  emptyTravellerForm,
  toTravellerInput,
  TRAVELLER_KINDS,
  TRAVELLER_TITLES,
  travellerFormFrom,
  travellerSchema,
  type TravellerFormInput,
  type TravellerFormOutput,
} from '@/features/account/travellerForm';
import { parseId } from '@/features/booking/refs';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { colors, fontFamily, spacing } from '@/theme';
import type { SavedTraveller } from '@/types/account';

function TravellerForm({ existing }: { existing: SavedTraveller | null }) {
  const router = useRouter();
  const save = useSaveTraveller();
  const singleFlight = useSingleFlight();
  const [error, setError] = useState<string | null>(null);

  const {
    control,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<TravellerFormInput, unknown, TravellerFormOutput>({
    resolver: zodResolver(travellerSchema),
    defaultValues: existing ? travellerFormFrom(existing) : emptyTravellerForm(),
  });
  const kind = useWatch({ control, name: 'traveller_type' });
  const title = useWatch({ control, name: 'title' });
  const [showFlyer, setShowFlyer] = useState(Boolean(existing?.frequent_flyer_number || existing?.frequent_flyer_airline));

  const submit = handleSubmit((values) =>
    singleFlight(async () => {
      setError(null);
      try {
        await save.mutateAsync({ id: existing?.customer_traveller_id ?? null, input: toTravellerInput(values) });
        if (router.canGoBack()) router.back();
        else router.replace('/travellers');
      } catch (e) {
        // Saving a traveller with no passport has no key to protect it from a repeat, so a lost answer says so.
        const unsure = isApiError(e) && (e.kind === 'network' || e.kind === 'timeout');
        setError(
          unsure
            ? 'We couldn’t confirm this was saved. Check your saved travellers before trying again, so you don’t end up with two.'
            : isApiError(e)
              ? e.message
              : 'Something went wrong. Please try again.',
        );
      }
    }),
  );

  return (
    <View style={styles.stack}>
      <View style={styles.kinds} accessibilityRole="radiogroup" accessibilityLabel="Passenger type">
        {TRAVELLER_KINDS.map((k) => {
          const on = kind === k.value;
          return (
            <Pressable
              key={k.value}
              onPress={() => setValue('traveller_type', k.value, { shouldDirty: true })}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`${k.label}, ${k.ages}`}
              style={[styles.kind, on && styles.kindOn]}
            >
              <Text variant="bodyStrong" color={on ? 'ink' : 'ink2'}>
                {k.label}
              </Text>
              <Text variant="caption" color="textSecondary">
                {k.ages}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Card style={styles.card}>
        <Text variant="h3" color="ink" accessibilityRole="header">
          Name and details
        </Text>
        <Text variant="small" color="textSecondary" style={styles.lede}>
          Exactly as on their passport or government ID.
        </Text>
        <View style={styles.titles} accessibilityRole="radiogroup" accessibilityLabel="Title (optional)">
          {TRAVELLER_TITLES.map((t) => {
            const on = title === t;
            return (
              <Pressable
                key={t}
                onPress={() => setValue('title', on ? '' : t, { shouldDirty: true })}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                style={[styles.title, on && styles.titleOn]}
              >
                <Text variant="small" chrome color={on ? 'ink' : 'ink2'} style={on ? styles.titleTextOn : styles.titleText}>
                  {t}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {/* One name per line, full width, in the order a passport prints them. */}
        <Controller control={control} name="first_name" render={({ field: { value, onChange, onBlur } }) => (
          <TextField label="First name" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.first_name?.message} autoComplete="given-name" autoCapitalize="words" returnKeyType="next" />
        )} />
        <Controller control={control} name="middle_name" render={({ field: { value, onChange, onBlur } }) => (
          <TextField label="Middle name (optional)" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.middle_name?.message} autoComplete="additional-name" autoCapitalize="words" returnKeyType="next" />
        )} />
        <Controller control={control} name="last_name" render={({ field: { value, onChange, onBlur } }) => (
          <TextField label="Last name" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.last_name?.message} autoComplete="family-name" autoCapitalize="words" />
        )} />
        <Controller control={control} name="date_of_birth" render={({ field: { value, onChange, onBlur } }) => (
          <TextField
            label="Date of birth (YYYY-MM-DD)"
            value={value}
            onChangeText={onChange}
            onBlur={onBlur}
            error={errors.date_of_birth?.message}
            autoCorrect={false}
            keyboardType="numbers-and-punctuation"
            placeholder="1990-04-23"
            maxLength={10}
          />
        )} />
        <Controller control={control} name="nationality" render={({ field: { value, onChange, onBlur } }) => (
          <TextField label="Nationality" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.nationality?.message} autoCapitalize="words" placeholder="Indian" />
        )} />
      </Card>

      <Card style={styles.card}>
        <View style={styles.cardHead}>
          <Text variant="h3" color="ink" accessibilityRole="header">
            Passport
          </Text>
          <Text variant="caption" color="textSecondary">
            Needed for trips abroad
          </Text>
        </View>
        <Controller control={control} name="passport_number" render={({ field: { value, onChange, onBlur } }) => (
          <TextField label="Passport number" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.passport_number?.message} autoCapitalize="characters" autoCorrect={false} placeholder="N1234567" />
        )} />
        <Controller control={control} name="passport_expiry" render={({ field: { value, onChange, onBlur } }) => (
          <TextField
            label="Passport expiry (YYYY-MM-DD)"
            value={value}
            onChangeText={onChange}
            onBlur={onBlur}
            error={errors.passport_expiry?.message}
            autoCorrect={false}
            keyboardType="numbers-and-punctuation"
            placeholder="2032-05-30"
            maxLength={10}
          />
        )} />
        <Controller control={control} name="issuing_country" render={({ field: { value, onChange, onBlur } }) => (
          <TextField label="Issuing country" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.issuing_country?.message} autoCapitalize="words" placeholder="India" />
        )} />
        <Text variant="small" color="textSecondary">
          It must be valid for at least 6 months after the trip ends.
        </Text>
      </Card>

      {showFlyer ? (
        <Card style={styles.card}>
          <Text variant="h3" color="ink" accessibilityRole="header">
            Frequent flyer
          </Text>
          <Controller control={control} name="frequent_flyer_airline" render={({ field: { value, onChange, onBlur } }) => (
            <TextField label="Airline" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.frequent_flyer_airline?.message} autoCapitalize="words" />
          )} />
          <Controller control={control} name="frequent_flyer_number" render={({ field: { value, onChange, onBlur } }) => (
            <TextField label="Frequent flyer number" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.frequent_flyer_number?.message} autoCapitalize="characters" autoCorrect={false} />
          )} />
        </Card>
      ) : (
        <Pressable onPress={() => setShowFlyer(true)} accessibilityRole="button" style={({ pressed }) => [styles.addFlyer, pressed && styles.pressed]}>
          <Ionicons name="add" size={18} color={colors.goldInk} />
          <Text variant="bodyStrong" color="ink" style={styles.flex}>
            Add a frequent flyer number (optional)
          </Text>
        </Pressable>
      )}

      {error ? <Banner tone="error" message={error} /> : null}
      <Button title={existing ? 'Save changes' : 'Save traveller'} loading={save.isPending} onPress={() => void submit()} />
    </View>
  );
}

/** Editing: the id must be one of THIS customer's saved travellers (the server's list is the authority). */
function ExistingTravellerForm({ id }: { id: number }) {
  const travellers = useTravellers();
  if (travellers.isPending) return <LoadingState message="Loading…" />;
  if (travellers.isError) return <ErrorState error={travellers.error} onRetry={() => void travellers.refetch()} retrying={travellers.isRefetching} />;
  const existing = travellers.data.find((t) => t.customer_traveller_id === id);
  if (!existing) {
    return <EmptyState icon="people-outline" title="We couldn’t find that traveller" message="They may have been removed." />;
  }
  return <TravellerForm key={existing.customer_traveller_id} existing={existing} />;
}

function EditTravellerContent() {
  const params = useLocalSearchParams<{ id?: string }>();
  const raw = Array.isArray(params.id) ? params.id[0] : params.id;
  const id = raw === undefined ? null : parseId(raw);

  // Adding has no id. An id that cannot be valid is refused before anything is asked of the server.
  if (raw === undefined) return <TravellerForm existing={null} />;
  if (id === null) {
    return <EmptyState icon="people-outline" title="We couldn’t find that traveller" message="The link may be old or mistyped." />;
  }
  return <ExistingTravellerForm id={id} />;
}

export default function EditTravellerScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  return (
    <Screen header={{ title: params.id ? 'Edit traveller' : 'Add a passenger', subtitle: 'Saved to your travellers', back: true, tone: 'light' }} scroll keyboard bottomInset>
      <AuthGate title="Saved travellers" message="Sign in to save the people you travel with.">
        <EditTravellerContent />
      </AuthGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.7 },
  stack: { gap: spacing.s3 },
  card: { gap: spacing.s3 },
  cardHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: spacing.s2 },
  lede: { marginTop: -spacing.s2 },
  kinds: { flexDirection: 'row', gap: spacing.s2 },
  kind: {
    flex: 1,
    minHeight: 56,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  kindOn: { borderWidth: 2, borderColor: colors.primary },
  titles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  title: { minWidth: 56, minHeight: 40, borderRadius: 12, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.s3 },
  titleOn: { borderWidth: 2, borderColor: colors.primary, backgroundColor: '#F1F4F9' },
  titleText: { fontFamily: fontFamily.sansBold },
  titleTextOn: { fontFamily: fontFamily.sansExtraBold },
  addFlyer: {
    minHeight: 52,
    borderRadius: 16,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.s4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s2,
  },
});
