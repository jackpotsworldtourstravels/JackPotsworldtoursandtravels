import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { StyleSheet, View } from 'react-native';
import type { z } from 'zod';

import { hotelApi } from '@/api/endpoints/booking';
import { isApiError } from '@/api/errors';
import { Banner, Button, Card, EmptyState, ErrorState, LoadingState, Screen, Text } from '@/components';
import { SectionHeader } from '@/components/layout';
import { useTravellers } from '@/features/account/hooks';
import { hotelGuestFromTraveller } from '@/features/account/travellerForm';
import { useAuthDetour, useRestoredDraft } from '@/features/auth/useReturnTo';
import { forget, keyFor } from '@/features/booking/attempts';
import { HotelGuestFields } from '@/features/booking/components/PeopleFields';
import { CouponField, QuoteSummary } from '@/features/booking/components/Quote';
import { bookingKeys, useHotelDetail, useHotelQuote } from '@/features/booking/hooks';
import {
  buildHotelBooking,
  buildHotelQuoteRequest,
  buildStay,
  emptyHotelForm,
  hotelFormSchema,
  normaliseCoupon,
  type HotelFormValues,
} from '@/features/booking/hotelRequest';
import { parseId } from '@/features/booking/refs';
import { normaliseParty, partySummary } from '@/features/search/party';
import { stayFromParams, stayProblem } from '@/features/search/stay';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { useAuth } from '@/providers/AuthProvider';
import { spacing } from '@/theme';
import { formatShortDate, nightsBetween } from '@/utils/dates';

const asString = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const asCount = (v: string | string[] | undefined, fallback: number) => {
  const n = Number(asString(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** A request that may or may not have reached the server: the retry is safe, and the message says so. */
const UNSURE = 'We couldn’t confirm whether your booking was made. Tap Confirm booking again; it won’t create a second one.';

/**
 * Review a stay and book it.
 *
 *   1. The server prices THESE room, dates and guests (a quote, shown under its own
 *      heading, separate from the indicative rate on the hotel page).
 *   2. Confirm creates a PENDING booking. Nothing is charged here.
 *   3. The booking page takes the payment.
 *
 * Double taps, timeouts and a killed app cannot make two bookings: the request
 * carries a key bound to exactly what is being booked (features/booking/attempts.ts).
 */
export default function BookHotelScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { hasSession, customer } = useAuth();
  const params = useLocalSearchParams<{
    hotelId?: string;
    roomId?: string;
    checkIn?: string;
    checkOut?: string;
    rooms?: string;
    adults?: string;
    children?: string;
  }>();

  const hotelId = parseId(params.hotelId);
  const roomId = parseId(params.roomId);
  const stay = stayFromParams({ checkIn: asString(params.checkIn), checkOut: asString(params.checkOut) });
  const party = normaliseParty({
    rooms: asCount(params.rooms, 1) || 1,
    adults: asCount(params.adults, 2) || 2,
    children: asCount(params.children, 0),
  });
  // Everything from the route is checked before anything is fetched or priced.
  const input =
    hotelId !== null && roomId !== null && stay !== null && stayProblem(stay) === null ? { hotelId, roomId, stay } : null;

  const detail = useHotelDetail(input?.hotelId ?? null);
  const room = detail.data?.rooms.find((r) => r.id === input?.roomId);

  // Coming back from signing in: the form and coupon the customer had, if this screen was torn down meanwhile.
  const restored = useRestoredDraft<HotelFormValues>('hotel');
  const detourToSignIn = useAuthDetour();

  const [coupon, setCoupon] = useState<string | undefined>(restored?.coupon);
  // The query key is built from this request's CONTENT, so a fresh object each render is fine.
  const stayInput = input && room ? buildStay({ ...input, party }) : null;
  const quote = useHotelQuote(stayInput ? buildHotelQuoteRequest(stayInput, coupon) : null);

  // The party comes from the route and does not change while this screen is open.
  const [schema] = useState(() => hotelFormSchema(party.adults + party.children));
  type Output = z.output<typeof schema>;
  const {
    control,
    handleSubmit,
    getValues,
    setValue,
    formState: { errors },
  } = useForm<HotelFormValues, unknown, Output>({
    resolver: zodResolver(schema),
    defaultValues: restored?.values ?? emptyHotelForm(party, prefillFrom(customer)),
  });

  const singleFlight = useSingleFlight();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = useTravellers();

  if (!input) {
    return (
      <Screen header={{ title: 'Book a stay', back: true }}>
        <EmptyState
          icon="calendar-outline"
          title="These booking details aren’t valid"
          message="The dates may have passed or the link is incomplete. Please choose your room again."
          actionLabel="Back"
          onAction={() => (router.canGoBack() ? router.back() : router.replace('/hotels'))}
        />
      </Screen>
    );
  }
  if (detail.isPending) {
    return (
      <Screen header={{ title: 'Book a stay', back: true }}>
        <LoadingState message="Loading your stay…" />
      </Screen>
    );
  }
  if (detail.isError || !room) {
    return (
      <Screen header={{ title: 'Book a stay', back: true }}>
        {detail.isError ? (
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        ) : (
          <EmptyState icon="bed-outline" title="That room isn’t available" message="Please go back and choose another room." actionLabel="Back" onAction={() => router.back()} />
        )}
      </Screen>
    );
  }

  const nights = nightsBetween(input.stay.checkIn, input.stay.checkOut);
  const quoteStale = quote.isPlaceholderData || (quote.isFetching && !quote.isPending);
  const couponError = quote.data?.coupon_error ?? null;
  const canConfirm = Boolean(quote.data) && !quoteStale && !couponError && !submitting;

  const confirm = handleSubmit((values) =>
    singleFlight(async () => {
      if (!hasSession) {
        // Sign in (or continue as a guest), then come back here with the form as it is: the root
        // takes the customer back, and this screen gets its form again if it was torn down.
        detourToSignIn('/sign-in', { kind: 'hotel', values: getValues(), coupon });
        return;
      }
      if (!stayInput || !quote.data) return;

      setSubmitting(true);
      setError(null);
      try {
        const body = buildHotelBooking({ stay: stayInput, values, coupon });
        const key = await keyFor('hotel', body);
        const booking = await hotelApi.create({ ...body, idempotency_key: key });
        await forget('hotel', body);
        queryClient.setQueryData(bookingKeys.one('hotel', booking.booking_ref), booking);
        void queryClient.invalidateQueries({ queryKey: bookingKeys.mine() });
        router.replace({ pathname: '/booking/[ref]', params: { ref: booking.booking_ref, quoted: quote.data.total_amount } });
      } catch (e) {
        const uncertain = isApiError(e) && (e.kind === 'network' || e.kind === 'timeout' || e.kind === 'server' || e.kind === 'unavailable');
        setError(uncertain ? UNSURE : isApiError(e) ? e.message : 'Something went wrong. Please try again.');
      } finally {
        setSubmitting(false);
      }
    }),
  );

  return (
    <Screen header={{ title: 'Review your stay', back: true }} scroll keyboard bottomInset>
      <Card>
        <Text variant="eyebrow" color="goldInk">
          Your stay
        </Text>
        <Text variant="h3" color="navy800">
          {detail.data.name}
        </Text>
        <Text variant="body" color="ink2">
          {room.name}
          {room.meal_plan ? ` · ${room.meal_plan}` : ''}
        </Text>
        <Text variant="small" color="muted">
          {formatShortDate(input.stay.checkIn)} to {formatShortDate(input.stay.checkOut)} · {nights} night{nights === 1 ? '' : 's'}
        </Text>
        <Text variant="small" color="muted">
          {partySummary(party)}
        </Text>
      </Card>

      <View style={styles.section}>
        <SectionHeader title="Price" />
        {quote.isPending ? (
          <LoadingState message="Pricing your stay…" />
        ) : quote.isError && !quote.data ? (
          <ErrorState error={quote.error} title="Couldn’t price your stay" onRetry={() => void quote.refetch()} retrying={quote.isRefetching} />
        ) : quote.data ? (
          <QuoteSummary quote={quote.data} stale={quoteStale} />
        ) : null}
        <CouponField
          applied={normaliseCoupon(coupon)}
          error={couponError}
          busy={quoteStale}
          onApply={setCoupon}
          onClear={() => setCoupon(undefined)}
        />
      </View>

      <View style={styles.section}>
        <SectionHeader title="Guests" />
        <HotelGuestFields
          control={control}
          errors={errors}
          adults={party.adults}
          childCount={party.children}
          picker={
            saved.data?.length
              ? {
                  travellers: saved.data,
                  onPick: (i, traveller) => {
                    const guest = hotelGuestFromTraveller(traveller);
                    setValue(`guests.${i}.first_name`, guest.first_name, { shouldValidate: true, shouldDirty: true });
                    setValue(`guests.${i}.last_name`, guest.last_name, { shouldValidate: true, shouldDirty: true });
                  },
                }
              : undefined
          }
        />
      </View>

      {room.cancellation_policy || detail.data.cancellation_policy ? (
        <Card>
          <Text variant="eyebrow" color="goldInk">
            Cancellation policy
          </Text>
          <Text variant="small" color="ink2">
            {room.cancellation_policy ?? detail.data.cancellation_policy}
          </Text>
        </Card>
      ) : null}

      {error ? <Banner tone="error" message={error} /> : null}
      {!hasSession ? (
        <Banner tone="info" message="You’ll sign in, or continue as a guest, when you confirm. What you’ve entered here is kept." />
      ) : null}
      <Text variant="small" color="muted" align="center">
        Confirming creates your booking; nothing is charged yet. You’ll have 30 minutes to pay on the next screen.
      </Text>
      <Button
        title={hasSession ? 'Confirm booking' : 'Sign in to book'}
        loading={submitting}
        disabled={!canConfirm}
        onPress={() => void confirm()}
      />
    </Screen>
  );
}

/** Pre-fill the contact guest from the signed-in account (never a guest session, which has no details). */
function prefillFrom(customer: { full_name: string; email: string | null; mobile: string | null; is_guest: boolean } | null) {
  if (!customer || customer.is_guest) return undefined;
  const [first = '', ...rest] = customer.full_name.trim().split(/\s+/);
  return { firstName: first, lastName: rest.join(' '), email: customer.email ?? '', mobile: customer.mobile ?? '' };
}

const styles = StyleSheet.create({
  section: { gap: spacing.s3 },
});
