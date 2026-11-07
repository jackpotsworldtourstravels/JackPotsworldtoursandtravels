import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { isApiError } from '@/api/errors';
import { Banner, Card, EmptyState, ErrorState, LoadingState, Screen, Text } from '@/components';
import { SectionHeader, Tag } from '@/components/layout';
import { SignInPrompt } from '@/components/AuthGate';
import { BookingHelp } from '@/features/booking/components/BookingHelp';
import { PaymentPanel } from '@/features/booking/components/PaymentPanel';
import { StatusBadge, bookingTitle, bookingWhen } from '@/features/booking/components/status';
import { useBooking } from '@/features/booking/hooks';
import { parseBookingRef } from '@/features/booking/refs';
import { useAuth } from '@/providers/AuthProvider';
import { colors, spacing } from '@/theme';
import type { AnyBooking, HotelBooking, PackageBooking } from '@/types/booking';
import { formatLongDate } from '@/utils/dates';
import { compareMoney, formatMoney, toDecimalString } from '@/utils/money';

const asString = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function Line({ label, value, strong = false, tone }: { label: string; value: string; strong?: boolean; tone?: 'success' }) {
  return (
    <View style={styles.line}>
      <Text variant={strong ? 'title' : 'body'} color={strong ? 'navy800' : 'ink2'} style={styles.grow}>
        {label}
      </Text>
      <Text variant={strong ? 'h3' : 'bodyStrong'} color={tone ?? (strong ? 'navy800' : 'ink')}>
        {value}
      </Text>
    </View>
  );
}

/** The booking's own money, exactly as the server recorded it. Amounts are strings; only the minus sign is added here. */
function Totals({ booking }: { booking: AnyBooking }) {
  const c = { currency: booking.currency };
  const positive = (v: string) => (toDecimalString(v) !== null && compareMoney(v, '0') > 0 ? v : null);
  const hotel = booking.product_type === 'hotel';
  const discount = positive(booking.discount);
  const addons = positive(booking.addon_total);
  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <Text variant="eyebrow" color="goldInk">
          Booking total
        </Text>
        <Tag label="Final price" tone="success" />
      </View>
      <Line label={hotel ? 'Rooms' : 'Package'} value={formatMoney(hotel ? (booking as HotelBooking).room_subtotal : (booking as PackageBooking).base_total, c)} />
      <Line label={hotel ? 'Taxes & service' : 'GST'} value={formatMoney(booking.taxes, c)} />
      {addons ? <Line label="Add-ons" value={formatMoney(addons, c)} /> : null}
      {discount ? (
        <Line label={booking.coupon_code ? `Discount (${booking.coupon_code})` : 'Discount'} value={`−${formatMoney(discount, c)}`} tone="success" />
      ) : null}
      <View style={styles.rule} />
      <Line label="Total" value={formatMoney(booking.total_amount, c)} strong />
    </Card>
  );
}

function People({ booking }: { booking: AnyBooking }) {
  const hotel = booking.product_type === 'hotel';
  const people = hotel
    ? (booking as HotelBooking).guests.map((g) => ({ key: g.guest_index, name: `${g.first_name} ${g.last_name}`, kind: g.guest_type, contact: g.is_contact, email: g.email, mobile: g.mobile }))
    : (booking as PackageBooking).travellers.map((t) => ({ key: t.traveller_index, name: `${t.first_name} ${t.last_name}`, kind: t.traveller_type, contact: t.is_contact, email: t.email, mobile: t.mobile }));
  if (people.length === 0) return null;
  return (
    <Card style={styles.card}>
      <Text variant="eyebrow" color="goldInk">
        {hotel ? 'Guests' : 'Travellers'}
      </Text>
      {people.map((p) => (
        <View key={p.key} style={styles.person}>
          <Text variant="bodyStrong">
            {p.name} <Text variant="small" color="muted">({p.kind})</Text>
          </Text>
          {p.contact ? (
            <Text variant="small" color="muted">
              Booking contact{p.email ? ` · ${p.email}` : ''}{p.mobile ? ` · ${p.mobile}` : ''}
            </Text>
          ) : null}
        </View>
      ))}
    </Card>
  );
}

function Summary({ booking }: { booking: AnyBooking }) {
  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <Text variant="eyebrow" color="goldInk" style={styles.grow}>
          {booking.product_type === 'hotel' ? 'Hotel' : 'Tour package'} · {booking.booking_ref}
        </Text>
        <StatusBadge booking={booking} />
      </View>
      <Text variant="h2" color="navy800" accessibilityRole="header">
        {bookingTitle(booking)}
      </Text>
      {booking.product_type === 'hotel' ? (
        <>
          <Text variant="body" color="ink2">
            {booking.room_name}
            {booking.meal_plan ? ` · ${booking.meal_plan}` : ''}
          </Text>
          {booking.hotel_location ? (
            <Text variant="small" color="muted">
              {booking.hotel_location}
            </Text>
          ) : null}
          <Text variant="small" color="muted">
            {booking.rooms_count} room{booking.rooms_count === 1 ? '' : 's'} · {booking.adults} adult{booking.adults === 1 ? '' : 's'}
            {booking.children ? ` · ${booking.children} child${booking.children === 1 ? '' : 'ren'}` : ''}
          </Text>
        </>
      ) : (
        <Text variant="small" color="muted">
          {booking.package_days} days · {booking.is_international ? 'International' : 'Domestic'}
        </Text>
      )}
      <Text variant="body" color="ink2">
        {bookingWhen(booking)}
      </Text>
      <Text variant="caption" color="muted">
        Booked {formatLongDate(booking.created_at.slice(0, 10))}
      </Text>
    </Card>
  );
}

/**
 * One booking and its payment. Everything here is the backend's record (the
 * booking's status, its price, its payment attempts); the page only ever asks
 * the backend to look again, it never decides that something was paid.
 *
 * `quoted` (a route parameter) is the total the customer was shown on the review
 * screen. It is compared with the booking's real total only to warn about a
 * difference, and is never used as a price.
 */
export default function BookingScreen() {
  const router = useRouter();
  const { status } = useAuth();
  const params = useLocalSearchParams<{ ref: string; quoted?: string }>();
  const parsed = parseBookingRef(asString(params.ref));
  const kind = parsed?.kind === 'hotel' || parsed?.kind === 'package' ? parsed.kind : null;
  // Nothing is asked of the server without a session: a booking belongs to the account that made it.
  const booking = useBooking(kind, parsed && kind ? parsed.ref : null, status === 'customer' || status === 'guest');

  if (!parsed) {
    return (
      <Screen header={{ title: 'Booking', back: true }}>
        <EmptyState icon="briefcase-outline" title="That isn’t a booking reference" message="Check the reference and try again." actionLabel="My bookings" onAction={() => router.replace('/bookings')} />
      </Screen>
    );
  }
  if (!kind) {
    return (
      <Screen header={{ title: parsed.ref, back: true }}>
        <EmptyState icon="airplane-outline" title="Flight bookings aren’t available in the app" message={`Please manage ${parsed.ref} on our website or contact support.`} actionLabel="My bookings" onAction={() => router.replace('/bookings')} />
      </Screen>
    );
  }
  if (status === 'loading') {
    return (
      <Screen header={{ title: parsed.ref, back: true }}>
        <LoadingState />
      </Screen>
    );
  }
  if (status === 'signedOut' || status === 'unavailable') {
    return (
      <Screen header={{ title: parsed.ref, back: true }} scroll>
        <SignInPrompt title="Sign in to see this booking" message="Bookings belong to the account that made them." />
      </Screen>
    );
  }
  if (booking.isPending) {
    return (
      <Screen header={{ title: parsed.ref, back: true }}>
        <LoadingState message="Loading your booking…" />
      </Screen>
    );
  }
  if (booking.isError || !booking.data) {
    const missing = isApiError(booking.error) && booking.error.kind === 'not_found';
    return (
      <Screen header={{ title: parsed.ref, back: true }}>
        {missing ? (
          <EmptyState icon="briefcase-outline" title="We couldn’t find that booking" message="It isn’t on this account." actionLabel="My bookings" onAction={() => router.replace('/bookings')} />
        ) : (
          <ErrorState error={booking.error} onRetry={() => void booking.refetch()} retrying={booking.isRefetching} />
        )}
      </Screen>
    );
  }

  const data = booking.data;
  const quoted = toDecimalString(asString(params.quoted));
  const priceChanged = quoted !== null && compareMoney(quoted, data.total_amount) !== 0;

  return (
    <Screen header={{ title: parsed.ref, back: true }} scroll bottomInset>
      {priceChanged ? (
        <Banner
          tone="warning"
          message={`The price changed between your quote and your booking: you were shown ${formatMoney(quoted, { currency: data.currency })}, and the booking total is ${formatMoney(data.total_amount, { currency: data.currency })}. Please check the total below before you pay.`}
        />
      ) : null}
      <Summary booking={data} />
      <Totals booking={data} />
      <PaymentPanel kind={kind} booking={data} autoCheck />
      <People booking={data} />

      {data.payments.length > 0 ? (
        <View style={styles.section}>
          <SectionHeader title="Payment attempts" />
          {data.payments.map((p, i) => (
            <Card key={`${p.created_at}-${i}`} style={styles.attempt}>
              <Text variant="bodyStrong" style={styles.grow}>
                {p.status.charAt(0).toUpperCase() + p.status.slice(1)}
              </Text>
              <Text variant="small" color="muted">
                {formatMoney(p.amount, { currency: p.currency })} · {formatLongDate(p.created_at.slice(0, 10))}
              </Text>
            </Card>
          ))}
        </View>
      ) : null}

      <BookingHelp booking={data} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.s3 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.s3 },
  line: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.s3 },
  grow: { flex: 1 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  person: { gap: 2 },
  section: { gap: spacing.s3 },
  attempt: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.s3 },
});
