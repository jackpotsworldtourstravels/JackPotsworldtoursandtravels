import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { StyleSheet, View } from 'react-native';

import { isApiError } from '@/api/errors';
import { AuthGate, Banner, Button, Card, Screen, Text, TextField } from '@/components';
import { Chip, ChipRow } from '@/components/layout';
import { useUpdateProfile } from '@/features/account/hooks';
import {
  GENDER_OPTIONS,
  profileChanges,
  profileFormFrom,
  profileProblem,
  profileSchema,
  type ProfileFormInput,
  type ProfileFormOutput,
} from '@/features/account/profileForm';
import { useAuthDetour } from '@/features/auth/useReturnTo';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { useAuth } from '@/providers/AuthProvider';
import { spacing } from '@/theme';
import type { Customer } from '@/types/api';

/**
 * Edit the customer's own details. Only what changed is sent (the server reads a
 * missing field as "leave it" and a null as "clear it"), email is shown but not
 * editable (it is the login identifier), and what the server answers becomes the
 * signed-in customer on every screen.
 */
function ProfileForm({ customer }: { customer: Customer }) {
  const update = useUpdateProfile();
  const singleFlight = useSingleFlight();
  const [notice, setNotice] = useState<{ tone: 'success' | 'info' | 'error'; text: string } | null>(null);

  const {
    control,
    handleSubmit,
    reset,
    setValue,
    formState: { errors },
  } = useForm<ProfileFormInput, unknown, ProfileFormOutput>({
    resolver: zodResolver(profileSchema),
    defaultValues: profileFormFrom(customer),
  });
  const gender = useWatch({ control, name: 'gender' }) ?? '';
  const genders = gender && !GENDER_OPTIONS.some((g) => g === gender) ? [...GENDER_OPTIONS, gender] : [...GENDER_OPTIONS];

  const save = handleSubmit((values) =>
    singleFlight(async () => {
      setNotice(null);
      const changes = profileChanges(customer, values);
      if (Object.keys(changes).length === 0) {
        setNotice({ tone: 'info', text: 'Nothing has changed.' });
        return;
      }
      const problem = profileProblem(customer, changes);
      if (problem) {
        setNotice({ tone: 'error', text: problem });
        return;
      }
      try {
        const updated = await update.mutateAsync(changes);
        reset(profileFormFrom(updated));
        setNotice({ tone: 'success', text: 'Your details are saved.' });
      } catch (e) {
        setNotice({ tone: 'error', text: isApiError(e) ? e.message : 'Something went wrong. Please try again.' });
      }
    }),
  );

  return (
    <View style={styles.stack}>
      <Card style={styles.card}>
        <Text variant="eyebrow" color="goldInk">
          About you
        </Text>
        <Controller control={control} name="full_name" render={({ field: { value, onChange, onBlur } }) => (
          <TextField label="Full name" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.full_name?.message} autoComplete="name" autoCapitalize="words" />
        )} />
        <TextField label="Email" value={customer.email ?? ''} editable={false} helper="Your email is how you sign in, so it can’t be changed here. Contact support to change it." />
        <Controller control={control} name="mobile" render={({ field: { value, onChange, onBlur } }) => (
          <TextField
            label="Mobile number"
            value={value}
            onChangeText={onChange}
            onBlur={onBlur}
            error={errors.mobile?.message}
            helper={customer.mobile_verified ? 'Changing your number marks it as not verified.' : 'Include your country code, for example +91.'}
            autoComplete="tel"
            keyboardType="phone-pad"
          />
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
        <View style={styles.group}>
          <Text variant="caption" color="ink2">
            Gender
          </Text>
          <ChipRow>
            {genders.map((g) => (
              <Chip key={g} label={g} selected={gender === g} onPress={() => setValue('gender', gender === g ? '' : g, { shouldDirty: true })} />
            ))}
          </ChipRow>
        </View>
      </Card>

      <Card style={styles.card}>
        <Text variant="eyebrow" color="goldInk">
          Address
        </Text>
        <Controller control={control} name="address_line1" render={({ field: { value, onChange, onBlur } }) => (
          <TextField label="Address line 1" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.address_line1?.message} autoComplete="address-line1" />
        )} />
        <Controller control={control} name="address_line2" render={({ field: { value, onChange, onBlur } }) => (
          <TextField label="Address line 2" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.address_line2?.message} autoComplete="address-line2" />
        )} />
        <Controller control={control} name="city" render={({ field: { value, onChange, onBlur } }) => (
          <TextField label="City" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.city?.message} autoCapitalize="words" />
        )} />
        <Controller control={control} name="state" render={({ field: { value, onChange, onBlur } }) => (
          <TextField label="State" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.state?.message} autoCapitalize="words" />
        )} />
        <Controller control={control} name="country" render={({ field: { value, onChange, onBlur } }) => (
          <TextField label="Country" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.country?.message} autoCapitalize="words" />
        )} />
        <Controller control={control} name="postal_code" render={({ field: { value, onChange, onBlur } }) => (
          <TextField label="Postal code" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.postal_code?.message} autoComplete="postal-code" />
        )} />
      </Card>

      {notice ? <Banner tone={notice.tone} message={notice.text} /> : null}
      <Button title="Save details" loading={update.isPending} onPress={() => void save()} />
    </View>
  );
}

/** A guest has no identity to edit. The way to have one is an account, and everything they did comes along. */
function GuestNeedsAccount() {
  const detour = useAuthDetour();
  return (
    <Card>
      <Text variant="h3" color="navy800" accessibilityRole="header">
        Create an account to add your details
      </Text>
      <Text variant="body" color="ink2">
        You’re browsing as a guest, so there’s no name or address to edit yet. Create an account and your bookings, wishlist and saved
        travellers come with you.
      </Text>
      <Button title="Create account" onPress={() => detour('/sign-up')} />
      <Button title="Sign in" variant="outline" onPress={() => detour('/sign-in')} />
    </Card>
  );
}

export default function EditProfileScreen() {
  const { customer, status } = useAuth();
  return (
    <Screen header={{ title: 'Edit details', back: true }} scroll keyboard bottomInset>
      <AuthGate title="Your details" message="Sign in to see and edit your details.">
        {status === 'guest' || !customer ? <GuestNeedsAccount /> : <ProfileForm customer={customer} />}
      </AuthGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.s3 },
  card: { gap: spacing.s3 },
  group: { gap: spacing.s2 },
});
