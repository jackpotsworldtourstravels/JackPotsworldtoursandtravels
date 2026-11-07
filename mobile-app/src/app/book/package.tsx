import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { StyleSheet, View } from 'react-native';
import type { z } from 'zod';

import { packageApi } from '@/api/endpoints/booking';
import { isApiError } from '@/api/errors';
import { Banner, Button, Card, EmptyState, ErrorState, LoadingState, Screen, Text } from '@/components';
import { SectionHeader } from '@/components/layout';
import { useTravellers } from '@/features/account/hooks';
import { packageFieldsFromTraveller } from '@/features/account/travellerForm';
import { useAuthDetour, useRestoredDraft } from '@/features/auth/useReturnTo';
import { forget, keyFor } from '@/features/booking/attempts';
import { PackageTravellerFields } from '@/features/booking/components/PeopleFields';
import { CouponField, QuoteSummary } from '@/features/booking/components/Quote';
import { bookingKeys, usePackageDetail, usePackageQuote } from '@/features/booking/hooks';
import { normaliseCoupon } from '@/features/booking/hotelRequest';
import {
  bookableDepartures,
  buildPackageBooking,
  buildTrip,
  emptyPackageForm,
  maxTravellers,
  packageFormSchema,
  type PackageFormValues,
  type TravellerType,
} from '@/features/booking/packageRequest';
import { parseId } from '@/features/booking/refs';
import { packageDuration, packagePlace } from '@/features/discovery/packages';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { useAuth } from '@/providers/AuthProvider';
import { spacing } from '@/theme';
import type { DepartureOption, PackageDetail } from '@/types/booking';
import { formatLongDate } from '@/utils/dates';

const UNSURE = 'We couldn’t confirm whether your booking was made. Tap Confirm booking again; it won’t create a second one.';

/**
 * Review a package trip and book it. The same shape as the hotel booking: a
 * server quote under its own heading, a pending booking on Confirm (nothing
 * charged), payment on the booking page, and a key bound to exactly what is being
 * booked so a retry can never make a second booking.
 *
 * A package booking HOLDS SEATS from the moment it is created. That is why the
 * booking page offers to cancel an unpaid one: it is the only way the seats go
 * back on sale.
 */
export default function BookPackageScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ packageId?: string; departureId?: string; pax?: string }>();
  const packageId = parseId(params.packageId);
  const departureId = parseId(params.departureId);
  const pax = Number(Array.isArray(params.pax) ? params.pax[0] : params.pax);

  const detail = usePackageDetail(packageId);

  const invalid = (
    <Screen header={{ title: 'Book a package', back: true }}>
      <EmptyState
        icon="calendar-outline"
        title="These booking details aren’t valid"
        message="The departure may no longer be open or the link is incomplete. Please choose your departure again."
        actionLabel="Back"
        onAction={() => (router.canGoBack() ? router.back() : router.replace('/packages'))}
      />
    </Screen>
  );

  if (packageId === null || departureId === null || !Number.isInteger(pax) || pax < 1) return invalid;
  if (detail.isPending) {
    return (
      <Screen header={{ title: 'Book a package', back: true }}>
        <LoadingState message="Loading your trip…" />
      </Screen>
    );
  }
  if (detail.isError) {
    return (
      <Screen header={{ title: 'Book a package', back: true }}>
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      </Screen>
    );
  }

  // Only a departure that is still in the future with seats counts: the server refuses any other.
  const departure = bookableDepartures(detail.data.departures).find((d) => d.id === departureId);
  if (!departure || pax > maxTravellers(departure)) return invalid;

  return <PackageBookingForm pkg={detail.data} departure={departure} pax={pax} />;
}

function PackageBookingForm({ pkg, departure, pax }: { pkg: PackageDetail; departure: DepartureOption; pax: number }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { hasSession, customer } = useAuth();
  const packageId = Number(pkg.id);

  // Coming back from signing in: the form and coupon the customer had, if this screen was torn down meanwhile.
  const restored = useRestoredDraft<PackageFormValues>('package');
  const detourToSignIn = useAuthDetour();

  const [coupon, setCoupon] = useState<string | undefined>(restored?.coupon);
  const trip = buildTrip({ packageId, departureId: departure.id, pax });
  const quote = usePackageQuote({ trip, addons: [], coupon_code: normaliseCoupon(coupon) ?? null });

  // Package, departure and traveller count are fixed by the route for this screen's life.
  const [schema] = useState(() =>
    packageFormSchema({ international: pkg.is_international, departure: departure.date, count: pax }),
  );
  type Output = z.output<typeof schema>;
  const registered = customer && !customer.is_guest ? customer : null;
  const [first = '', ...rest] = (registered?.full_name ?? '').trim().split(/\s+/);
  const {
    control,
    handleSubmit,
    setValue,
    getValues,
    formState: { errors },
  } = useForm<PackageFormValues, unknown, Output>({
    resolver: zodResolver(schema),
    defaultValues:
      restored?.values ??
      emptyPackageForm(pax, {
        firstName: first,
        lastName: rest.join(' '),
        email: registered?.email ?? '',
        mobile: registered?.mobile ?? '',
      }),
  });
  const types = (useWatch({ control, name: 'travellers' }) ?? []).map((t) => t.traveller_type);

  const singleFlight = useSingleFlight();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = useTravellers();

  const quoteStale = quote.isPlaceholderData || (quote.isFetching && !quote.isPending);
  const couponError = quote.data?.coupon_error ?? null;
  const canConfirm = Boolean(quote.data) && !quoteStale && !couponError && !submitting;

  const confirm = handleSubmit((values) =>
    singleFlight(async () => {
      if (!hasSession) {
        // Sign in (or continue as a guest), then come back here with the form as it is.
        detourToSignIn('/sign-in', { kind: 'package', values: getValues(), coupon });
        return;
      }
      if (!quote.data) return;

      setSubmitting(true);
      setError(null);
      try {
        const body = buildPackageBooking({ trip, values, international: pkg.is_international, coupon });
        const key = await keyFor('package', body);
        const booking = await packageApi.create({ ...body, idempotency_key: key });
        await forget('package', body);
        queryClient.setQueryData(bookingKeys.one('package', booking.booking_ref), booking);
        void queryClient.invalidateQueries({ queryKey: bookingKeys.mine() });
        void queryClient.invalidateQueries({ queryKey: bookingKeys.package(packageId) });
        router.replace({ pathname: '/booking/[ref]', params: { ref: booking.booking_ref, quoted: quote.data.total_amount } });
      } catch (e) {
        const uncertain = isApiError(e) && (e.kind === 'network' || e.kind === 'timeout' || e.kind === 'server' || e.kind === 'unavailable');
        setError(uncertain ? UNSURE : isApiError(e) ? e.message : 'Something went wrong. Please try again.');
      } finally {
        setSubmitting(false);
      }
    }),
  );

  const place = packagePlace(pkg);

  return (
    <Screen header={{ title: 'Review your trip', back: true }} scroll keyboard bottomInset>
      <Card>
        <Text variant="eyebrow" color="goldInk">
          Your trip
        </Text>
        <Text variant="h3" color="navy800">
          {pkg.name}
        </Text>
        {place ? (
          <Text variant="body" color="ink2">
            {place}
          </Text>
        ) : null}
        <Text variant="small" color="muted">
          Departs {formatLongDate(departure.date)} · {packageDuration(pkg)}
        </Text>
        <Text variant="small" color="muted">
          {pax} traveller{pax === 1 ? '' : 's'}
        </Text>
      </Card>

      <View style={styles.section}>
        <SectionHeader title="Price" />
        {quote.isPending ? (
          <LoadingState message="Pricing your trip…" />
        ) : quote.isError && !quote.data ? (
          <ErrorState error={quote.error} title="Couldn’t price your trip" onRetry={() => void quote.refetch()} retrying={quote.isRefetching} />
        ) : quote.data ? (
          <QuoteSummary quote={quote.data} stale={quoteStale} />
        ) : null}
        <CouponField applied={normaliseCoupon(coupon)} error={couponError} busy={quoteStale} onApply={setCoupon} onClear={() => setCoupon(undefined)} />
      </View>

      <View style={styles.section}>
        <SectionHeader title="Travellers" />
        {pkg.is_international ? (
          <Banner tone="info" message="This is an international trip, so every traveller needs a passport valid for at least 6 months after the departure date." />
        ) : null}
        <PackageTravellerFields
          control={control}
          errors={errors}
          count={pax}
          international={pkg.is_international}
          departureLabel={formatLongDate(departure.date)}
          types={types as TravellerType[]}
          onTypeChange={(i, t) => setValue(`travellers.${i}.traveller_type`, t, { shouldValidate: true })}
          picker={
            saved.data?.length
              ? {
                  travellers: saved.data,
                  onPick: (i, traveller) => {
                    const fields = packageFieldsFromTraveller(traveller);
                    const opts = { shouldValidate: true, shouldDirty: true } as const;
                    // The first traveller is the booking contact and is always an adult.
                    setValue(`travellers.${i}.traveller_type`, i === 0 ? 'adult' : fields.traveller_type, opts);
                    setValue(`travellers.${i}.first_name`, fields.first_name, opts);
                    setValue(`travellers.${i}.last_name`, fields.last_name, opts);
                    setValue(`travellers.${i}.passport_number`, fields.passport_number, opts);
                    setValue(`travellers.${i}.passport_expiry`, fields.passport_expiry, opts);
                  },
                }
              : undefined
          }
        />
        {errors.travellers?.root?.message ?? errors.travellers?.message ? (
          <Banner tone="error" message={errors.travellers?.root?.message ?? errors.travellers?.message ?? ''} />
        ) : null}
      </View>

      {pkg.cancellation_policy ? (
        <Card>
          <Text variant="eyebrow" color="goldInk">
            Cancellation policy
          </Text>
          <Text variant="small" color="ink2">
            {pkg.cancellation_policy}
          </Text>
        </Card>
      ) : null}

      {error ? <Banner tone="error" message={error} /> : null}
      {!hasSession ? (
        <Banner tone="info" message="You’ll sign in, or continue as a guest, when you confirm. What you’ve entered here is kept." />
      ) : null}
      <Text variant="small" color="muted" align="center">
        Confirming creates your booking and holds your seats; nothing is charged yet. You’ll have 30 minutes to pay on the next screen.
      </Text>
      <Button title={hasSession ? 'Confirm booking' : 'Sign in to book'} loading={submitting} disabled={!canConfirm} onPress={() => void confirm()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.s3 },
});
