import { useRef } from 'react';
import { Controller, type Control, type FieldErrors } from 'react-hook-form';
import { StyleSheet, View } from 'react-native';

import { Card } from '@/components/Card';
import { Chip, ChipRow } from '@/components/layout';
import { Text } from '@/components/Text';
import { TextField, type TextFieldHandle } from '@/components/TextField';
import { SavedTravellerPicker } from '@/features/account/components/SavedTravellerPicker';
import { spacing } from '@/theme';
import type { SavedTraveller } from '@/types/account';

import type { HotelFormValues } from '../hotelRequest';
import type { PackageFormValues, TravellerType } from '../packageRequest';

/** The customer's saved travellers, offered per person. Absent (or empty) means no picker is shown. */
export interface TravellerPicker {
  travellers: readonly SavedTraveller[];
  onPick: (index: number, traveller: SavedTraveller) => void;
}

/**
 * Contact and guest names for a hotel stay. Adults come first and the first
 * adult is the booking contact (the server wants exactly one), so the email and
 * mobile sit with them.
 */
export function HotelGuestFields({
  control,
  errors,
  adults,
  childCount,
  picker,
}: {
  control: Control<HotelFormValues>;
  errors: FieldErrors<HotelFormValues>;
  adults: number;
  childCount: number;
  picker?: TravellerPicker;
}) {
  const last0 = useRef<TextFieldHandle>(null);
  const email = useRef<TextFieldHandle>(null);
  const mobile = useRef<TextFieldHandle>(null);
  const total = adults + childCount;

  return (
    <View style={styles.stack}>
      {Array.from({ length: total }, (_, i) => {
        const isAdult = i < adults;
        const label = isAdult ? `Adult ${i + 1}` : `Child ${i - adults + 1}`;
        const fieldErrors = errors.guests?.[i];
        return (
          <Card key={i} style={styles.card}>
            <Text variant="eyebrow" color="goldInk">
              {i === 0 ? `${label} · booking contact` : label}
            </Text>
            {picker ? <SavedTravellerPicker travellers={picker.travellers} onPick={(t) => picker.onPick(i, t)} /> : null}
            <Controller
              control={control}
              name={`guests.${i}.first_name`}
              render={({ field: { value, onChange, onBlur } }) => (
                <TextField
                  label="First name"
                  value={value}
                  onChangeText={onChange}
                  onBlur={onBlur}
                  error={fieldErrors?.first_name?.message}
                  autoComplete="given-name"
                  autoCapitalize="words"
                  returnKeyType="next"
                  onSubmitEditing={i === 0 ? () => last0.current?.focus() : undefined}
                />
              )}
            />
            <Controller
              control={control}
              name={`guests.${i}.last_name`}
              render={({ field: { value, onChange, onBlur } }) => (
                <TextField
                  ref={i === 0 ? last0 : undefined}
                  label="Last name"
                  value={value}
                  onChangeText={onChange}
                  onBlur={onBlur}
                  error={fieldErrors?.last_name?.message}
                  autoComplete="family-name"
                  autoCapitalize="words"
                  returnKeyType={i === 0 ? 'next' : 'done'}
                  onSubmitEditing={i === 0 ? () => email.current?.focus() : undefined}
                />
              )}
            />
            {i === 0 ? (
              <>
                <Controller
                  control={control}
                  name="email"
                  render={({ field: { value, onChange, onBlur } }) => (
                    <TextField
                      ref={email}
                      label="Email"
                      value={value}
                      onChangeText={onChange}
                      onBlur={onBlur}
                      error={errors.email?.message}
                      helper="Your booking confirmation is sent here."
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="email"
                      keyboardType="email-address"
                      returnKeyType="next"
                      onSubmitEditing={() => mobile.current?.focus()}
                    />
                  )}
                />
                <Controller
                  control={control}
                  name="mobile"
                  render={({ field: { value, onChange, onBlur } }) => (
                    <TextField
                      ref={mobile}
                      label="Mobile number"
                      value={value}
                      onChangeText={onChange}
                      onBlur={onBlur}
                      error={errors.mobile?.message}
                      helper="Include your country code, for example +91."
                      autoComplete="tel"
                      keyboardType="phone-pad"
                      returnKeyType="done"
                    />
                  )}
                />
              </>
            ) : null}
          </Card>
        );
      })}
      <Controller
        control={control}
        name="notes"
        render={({ field: { value, onChange, onBlur } }) => (
          <TextField
            label="Notes for the hotel (optional)"
            value={value}
            onChangeText={onChange}
            onBlur={onBlur}
            error={errors.notes?.message}
            multiline
            maxLength={500}
            placeholder="Arrival time, bed preference…"
          />
        )}
      />
    </View>
  );
}

const TYPES: { value: TravellerType; label: string }[] = [
  { value: 'adult', label: 'Adult' },
  { value: 'child', label: 'Child' },
  { value: 'infant', label: 'Infant' },
];

/**
 * Names (and, for an international package, passport details) for each
 * traveller. The first traveller is the contact and is always an adult, so the
 * "at least one adult" rule holds by construction.
 */
export function PackageTravellerFields({
  control,
  errors,
  count,
  international,
  departureLabel,
  types,
  onTypeChange,
  picker,
}: {
  control: Control<PackageFormValues>;
  errors: FieldErrors<PackageFormValues>;
  count: number;
  international: boolean;
  /** For the helper under the expiry box: "after 24 Oct 2026". */
  departureLabel: string;
  types: TravellerType[];
  onTypeChange: (index: number, type: TravellerType) => void;
  picker?: TravellerPicker;
}) {
  const email = useRef<TextFieldHandle>(null);
  const mobile = useRef<TextFieldHandle>(null);

  return (
    <View style={styles.stack}>
      {Array.from({ length: count }, (_, i) => {
        const e = errors.travellers?.[i];
        return (
          <Card key={i} style={styles.card}>
            <Text variant="eyebrow" color="goldInk">
              {i === 0 ? 'Traveller 1 · booking contact' : `Traveller ${i + 1}`}
            </Text>
            {picker ? <SavedTravellerPicker travellers={picker.travellers} onPick={(t) => picker.onPick(i, t)} /> : null}
            {i > 0 ? (
              <ChipRow>
                {TYPES.map((t) => (
                  <Chip key={t.value} label={t.label} selected={types[i] === t.value} onPress={() => onTypeChange(i, t.value)} />
                ))}
              </ChipRow>
            ) : null}
            <Controller
              control={control}
              name={`travellers.${i}.first_name`}
              render={({ field: { value, onChange, onBlur } }) => (
                <TextField
                  label="First name"
                  value={value}
                  onChangeText={onChange}
                  onBlur={onBlur}
                  error={e?.first_name?.message}
                  autoComplete="given-name"
                  autoCapitalize="words"
                  returnKeyType="next"
                />
              )}
            />
            <Controller
              control={control}
              name={`travellers.${i}.last_name`}
              render={({ field: { value, onChange, onBlur } }) => (
                <TextField
                  label="Last name"
                  value={value}
                  onChangeText={onChange}
                  onBlur={onBlur}
                  error={e?.last_name?.message}
                  autoComplete="family-name"
                  autoCapitalize="words"
                  returnKeyType="next"
                />
              )}
            />
            {international ? (
              <>
                <Controller
                  control={control}
                  name={`travellers.${i}.passport_number`}
                  render={({ field: { value, onChange, onBlur } }) => (
                    <TextField
                      label="Passport number"
                      value={value}
                      onChangeText={onChange}
                      onBlur={onBlur}
                      error={e?.passport_number?.message}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      returnKeyType="next"
                    />
                  )}
                />
                <Controller
                  control={control}
                  name={`travellers.${i}.passport_expiry`}
                  render={({ field: { value, onChange, onBlur } }) => (
                    <TextField
                      label="Passport expiry (YYYY-MM-DD)"
                      value={value}
                      onChangeText={onChange}
                      onBlur={onBlur}
                      error={e?.passport_expiry?.message}
                      helper={`Must be valid for at least 6 months after ${departureLabel}.`}
                      autoCorrect={false}
                      keyboardType="numbers-and-punctuation"
                      placeholder="2032-05-30"
                      maxLength={10}
                      returnKeyType={i === 0 ? 'next' : 'done'}
                    />
                  )}
                />
              </>
            ) : null}
            {i === 0 ? (
              <>
                <Controller
                  control={control}
                  name="email"
                  render={({ field: { value, onChange, onBlur } }) => (
                    <TextField
                      ref={email}
                      label="Email"
                      value={value}
                      onChangeText={onChange}
                      onBlur={onBlur}
                      error={errors.email?.message}
                      helper="Your booking confirmation is sent here."
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="email"
                      keyboardType="email-address"
                      returnKeyType="next"
                      onSubmitEditing={() => mobile.current?.focus()}
                    />
                  )}
                />
                <Controller
                  control={control}
                  name="mobile"
                  render={({ field: { value, onChange, onBlur } }) => (
                    <TextField
                      ref={mobile}
                      label="Mobile number"
                      value={value}
                      onChangeText={onChange}
                      onBlur={onBlur}
                      error={errors.mobile?.message}
                      helper="Include your country code, for example +91."
                      autoComplete="tel"
                      keyboardType="phone-pad"
                      returnKeyType="done"
                    />
                  )}
                />
              </>
            ) : null}
          </Card>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.s3 },
  card: { gap: spacing.s3 },
});
