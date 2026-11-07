import { zodResolver } from '@hookform/resolvers/zod';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { StyleSheet, View } from 'react-native';

import { isApiError } from '@/api/errors';
import { AuthGate, Banner, Button, Card, EmptyState, ErrorState, LoadingState, Screen, Text, TextField } from '@/components';
import { Chip, ChipRow } from '@/components/layout';
import { useSaveTraveller, useTravellers } from '@/features/account/hooks';
import {
  emptyTravellerForm,
  toTravellerInput,
  TRAVELLER_KINDS,
  travellerFormFrom,
  travellerSchema,
  type TravellerFormInput,
  type TravellerFormOutput,
} from '@/features/account/travellerForm';
import { parseId } from '@/features/booking/refs';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { spacing } from '@/theme';
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
      <Card style={styles.card}>
        <Text variant="eyebrow" color="goldInk">
          Who
        </Text>
        <ChipRow>
          {TRAVELLER_KINDS.map((k) => (
            <Chip key={k.value} label={k.label} selected={kind === k.value} onPress={() => setValue('traveller_type', k.value, { shouldDirty: true })} />
          ))}
        </ChipRow>
        <Controller control={control} name="first_name" render={({ field: { value, onChange, onBlur } }) => (
          <TextField label="First name" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.first_name?.message} autoComplete="given-name" autoCapitalize="words" />
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
          <TextField label="Nationality" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.nationality?.message} autoCapitalize="words" />
        )} />
      </Card>

      <Card style={styles.card}>
        <Text variant="eyebrow" color="goldInk">
          Passport (optional)
        </Text>
        <Controller control={control} name="passport_number" render={({ field: { value, onChange, onBlur } }) => (
          <TextField label="Passport number" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.passport_number?.message} autoCapitalize="characters" autoCorrect={false} />
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
          <TextField label="Issuing country" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.issuing_country?.message} autoCapitalize="words" />
        )} />
      </Card>

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
    <Screen header={{ title: params.id ? 'Edit traveller' : 'Add a traveller', back: true }} scroll keyboard bottomInset>
      <AuthGate title="Saved travellers" message="Sign in to save the people you travel with.">
        <EditTravellerContent />
      </AuthGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.s3 },
  card: { gap: spacing.s3 },
});
