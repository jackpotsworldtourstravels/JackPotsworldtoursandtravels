import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useRouter, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AuthGate, Banner, Button, Card, ListRow, Screen, Text } from '@/components';
import { env } from '@/config/env';
import { useTravellers, useWishlist } from '@/features/account/hooks';
import { useAuthDetour } from '@/features/auth/useReturnTo';
import { groupBookings } from '@/features/booking/groups';
import { useMyBookings } from '@/features/booking/hooks';
import { DevStatus } from '@/features/dev/DevStatus';
import { COMPANY_LINKS, LEGAL_LINKS, type InfoLink } from '@/features/info/links';
import { useAuth } from '@/providers/AuthProvider';
import { colors, fontFamily, spacing } from '@/theme';
import type { Customer } from '@/types/api';
import { formatLongDate, isISODate } from '@/utils/dates';

function addressOf(c: Customer): string | null {
  const lines = [c.address_line1, c.address_line2, [c.city, c.state].filter(Boolean).join(', '), [c.country, c.postal_code].filter(Boolean).join(' ')].filter(
    (line): line is string => Boolean(line && line.trim()),
  );
  return lines.length ? lines.join('\n') : null;
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');

/** Email or mobile with whether it is verified, as a pill. */
function ContactLine({ icon, value, verified, last = false }: { icon: keyof typeof Ionicons.glyphMap; value: string; verified: boolean; last?: boolean }) {
  return (
    <View style={[styles.contact, !last && styles.rule]}>
      <Ionicons name={icon} size={19} color={colors.goldInk} />
      <Text variant="bodyStrong" color="ink" style={styles.flex} numberOfLines={1}>
        {value}
      </Text>
      <View style={[styles.pill, verified ? styles.pillOk : styles.pillWarn]}>
        <Text variant="caption" chrome style={verified ? styles.pillOkText : styles.pillWarnText}>
          {verified ? 'Verified' : 'Not verified'}
        </Text>
      </View>
    </View>
  );
}

/** A label and value; nothing at all when the value is blank. */
function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <View style={styles.detail}>
      <Text variant="caption" color="textSecondary">
        {label}
      </Text>
      <Text variant="bodyStrong" color="ink">
        {value}
      </Text>
    </View>
  );
}

/**
 * The website's information pages: company and legal, as its footer lists them (features/info/links.ts). They are
 * the website's own, opened in an in-app browser so there is one copy to keep correct. Image credits matter here:
 * most of the destination photographs are CC BY or CC BY-SA and require attribution.
 */
function LinkGroup({ title, links }: { title: string; links: readonly InfoLink[] }) {
  return (
    <View style={styles.group}>
      <Text variant="label" color="textSecondary" style={styles.groupTitle}>
        {title}
      </Text>
      <Card style={styles.menu}>
        {links.map((link, i) => (
          <Pressable
            key={link.path}
            onPress={() => void WebBrowser.openBrowserAsync(`${env.apiBaseUrl}${link.path}`)}
            accessibilityRole="link"
            accessibilityLabel={link.label}
            accessibilityHint="Opens in an in-app browser"
            style={({ pressed }) => [styles.link, i === links.length - 1 && styles.linkLast, pressed && styles.pressed]}
          >
            <Text variant="bodyStrong" color="ink" style={styles.flex}>
              {link.label}
            </Text>
            <Ionicons name="open-outline" size={17} color={colors.textDisabled} />
          </Pressable>
        ))}
      </Card>
    </View>
  );
}

/** The navy band at the top: who this is, or that they are browsing as a guest. */
function Band({ customer, guest }: { customer: Customer | null; guest: boolean }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const account = !guest && customer ? customer : null;
  return (
    <View style={[styles.band, { paddingTop: insets.top + spacing.s3, paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right }]}>
      <View style={styles.bandTop}>
        <Text variant="h2" color="white">
          Profile
        </Text>
        {account ? (
          <Pressable onPress={() => router.push('/account/edit')} accessibilityRole="button" style={({ pressed }) => [styles.edit, pressed && styles.pressed]}>
            <Ionicons name="create-outline" size={15} color={colors.goldLight} />
            <Text variant="small" chrome color="goldLight" style={styles.editText}>
              Edit details
            </Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.who}>
        <View style={styles.bigAvatar} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {account ? (
            <Text variant="hero" chrome color="navy900">
              {initialsOf(account.full_name) || '?'}
            </Text>
          ) : (
            <Ionicons name="person" size={30} color={colors.navy900} />
          )}
        </View>
        <View style={styles.flex}>
          <Text variant="hero" color="white" accessibilityRole="header" numberOfLines={2} style={styles.name}>
            {account ? account.full_name : 'Browsing as a guest'}
          </Text>
          <Text variant="small" color="onDark2">
            {account ? `Customer code ${account.customer_code}` : 'Your trips are kept on this phone'}
          </Text>
        </View>
      </View>
    </View>
  );
}

/** Three real counts, each opening its list. */
function Summary() {
  const router = useRouter();
  const bookings = useMyBookings();
  const travellers = useTravellers();
  const wishlist = useWishlist();
  const upcoming = bookings.data
    ? groupBookings(bookings.data)
        .filter((s) => s.group === 'awaiting' || s.group === 'upcoming')
        .reduce((n, s) => n + s.rows.length, 0)
    : null;
  const items: { n: number | null; label: string; spoken: string; href: Href }[] = [
    { n: upcoming, label: 'Upcoming trips', spoken: 'upcoming trips', href: '/bookings' },
    { n: travellers.data?.length ?? null, label: 'Saved travellers', spoken: 'saved travellers', href: '/travellers' },
    { n: wishlist.data?.length ?? null, label: 'Wishlist', spoken: 'in your wishlist', href: '/wishlist' },
  ];
  return (
    <View style={styles.summary}>
      {items.map((item, i) => (
        <Pressable
          key={item.label}
          onPress={() => router.push(item.href)}
          accessibilityRole="button"
          accessibilityLabel={`${item.n === null ? 'Loading' : item.n} ${item.spoken}`}
          style={({ pressed }) => [styles.stat, i < items.length - 1 && styles.statRule, pressed && styles.pressed]}
        >
          <Text variant="h1" color="ink">
            {item.n === null ? '–' : String(item.n)}
          </Text>
          <Text variant="caption" color="textSecondary" align="center">
            {item.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/** A guest has a session but no account. Everything they do is kept for them when they make one. */
function GuestCard() {
  const detour = useAuthDetour();
  return (
    <Card>
      <Text variant="body" color="ink2">
        Your bookings, wishlist and saved travellers are kept for you on this phone. Create an account, or sign in to the one you have, and they
        come with you to every device.
      </Text>
      <Button title="Create account" onPress={() => detour('/sign-up')} />
      <Button title="Sign in" variant="outline" onPress={() => detour('/sign-in')} />
    </Card>
  );
}

function AccountDetails({ customer }: { customer: Customer }) {
  const birthday = customer.date_of_birth && isISODate(customer.date_of_birth) ? formatLongDate(customer.date_of_birth) : null;
  const address = addressOf(customer);
  const hasMore = Boolean(birthday || customer.gender || address);
  return (
    <>
      {customer.email || customer.mobile ? (
        <Card style={styles.menu}>
          {customer.email ? <ContactLine icon="mail-outline" value={customer.email} verified={customer.email_verified} last={!customer.mobile} /> : null}
          {customer.mobile ? <ContactLine icon="phone-portrait-outline" value={customer.mobile} verified={customer.mobile_verified} last /> : null}
        </Card>
      ) : null}
      {hasMore ? (
        <Card style={styles.details}>
          <Detail label="Date of birth" value={birthday} />
          <Detail label="Gender" value={customer.gender} />
          <Detail label="Address" value={address} />
        </Card>
      ) : null}
    </>
  );
}

function SignOut({ guest }: { guest: boolean }) {
  const { signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await signOut();
    } finally {
      setBusy(false);
    }
  };

  if (guest && confirming) {
    return (
      <View style={styles.confirm}>
        <Banner
          tone="warning"
          message="Ending a guest session removes your way back to your bookings, wishlist and saved travellers on this phone. Create an account first to keep them."
        />
        <Button title="End guest session" variant="danger" loading={busy} onPress={run} />
        <Button title="Keep my session" variant="ghost" disabled={busy} onPress={() => setConfirming(false)} />
      </View>
    );
  }
  return (
    <Button
      title={guest ? 'End guest session' : 'Sign out'}
      variant="outline"
      icon="log-out-outline"
      loading={busy}
      onPress={() => (guest ? setConfirming(true) : void run())}
    />
  );
}

/**
 * PROFILE. A navy band with the customer's initials, name and code; a card of three real counts overlapping it; their
 * contact details with whether each is verified; then everything about their account in two short lists, the
 * website's information pages, and signing out. A guest sees how to keep what they have done.
 */
export default function ProfileScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { customer, status, hasSession } = useAuth();
  const guest = status === 'guest';
  const [diagnostics, setDiagnostics] = useState(false);
  const side = { paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right };

  return (
    <Screen scroll flush bottomInset={false} statusBar="light">
      <Band customer={customer} guest={guest} />
      <View style={[styles.body, side]}>
        {hasSession ? <Summary /> : <View style={styles.noSummary} />}
        <AuthGate title="Your profile" message="Sign in to manage your details and see your account.">
          {guest || !customer ? <GuestCard /> : <AccountDetails customer={customer} />}

          <View style={styles.group}>
            <Text variant="label" color="textSecondary" style={styles.groupTitle}>
              Account
            </Text>
            <Card style={styles.menu}>
              <ListRow icon="ticket-outline" title="My bookings" subtitle="Upcoming, past and cancelled" onPress={() => router.push('/bookings')} />
              <ListRow icon="card-outline" title="Payments" subtitle="Your payments and refunds" onPress={() => router.push('/payments')} />
              <ListRow icon="heart-outline" title="Wishlist" subtitle="Hotels and tour packages you saved" onPress={() => router.push('/wishlist')} />
              <ListRow icon="people-outline" title="Saved travellers" subtitle="Names and passports for faster booking" onPress={() => router.push('/travellers')} />
              <ListRow icon="pricetag-outline" title="Offers and coupons" subtitle="Codes you can use today" onPress={() => router.push('/offers')} last />
            </Card>
          </View>

          <View style={styles.group}>
            <Text variant="label" color="textSecondary" style={styles.groupTitle}>
              Help & settings
            </Text>
            <Card style={styles.menu}>
              <ListRow icon="notifications-outline" title="Notifications" subtitle="Booking updates and messages" onPress={() => router.push('/notifications')} />
              <ListRow icon="headset-outline" title="Help and support" subtitle="Call us, or send a message" onPress={() => router.push('/support')} />
              {guest ? null : (
                <ListRow icon="phone-portrait-outline" title="Where you’re signed in" subtitle="Devices and browsers" onPress={() => router.push('/account/sessions')} />
              )}
              <ListRow icon="trash-outline" title="Delete my account" subtitle="Ask us to delete your account and data" tone="danger" onPress={() => router.push('/account/delete')} last />
            </Card>
          </View>

          <SignOut guest={guest} />
        </AuthGate>

        <LinkGroup title="About" links={COMPANY_LINKS} />
        <LinkGroup title="Legal" links={LEGAL_LINKS} />
        {/* Development builds only: a long press on the version opens the connection diagnostics. */}
        <Pressable onLongPress={__DEV__ ? () => setDiagnostics((d) => !d) : undefined} accessible={false}>
          <Text variant="caption" color="textSecondary" align="center">
            Version {Constants.expoConfig?.version ?? '—'}
          </Text>
        </Pressable>
        {__DEV__ && diagnostics ? <DevStatus /> : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.7 },
  band: { backgroundColor: colors.navy900, paddingBottom: 64, gap: spacing.s4 },
  bandTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  edit: { minHeight: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.navy600, paddingHorizontal: spacing.s3, flexDirection: 'row', alignItems: 'center', gap: 6 },
  editText: { fontFamily: fontFamily.sansBold },
  who: { flexDirection: 'row', alignItems: 'center', gap: spacing.s4 },
  bigAvatar: { width: 68, height: 68, borderRadius: 34, backgroundColor: colors.gold, alignItems: 'center', justifyContent: 'center', borderWidth: 4, borderColor: colors.navy700 },
  name: { fontSize: 22, lineHeight: 28 },
  body: { gap: spacing.s4, paddingBottom: spacing.s8 },
  summary: {
    marginTop: -44,
    backgroundColor: colors.surface,
    borderRadius: 20,
    flexDirection: 'row',
    paddingVertical: spacing.s3,
    shadowColor: colors.navy900,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.12,
    shadowRadius: 22,
    elevation: 5,
  },
  noSummary: { height: spacing.s1 },
  stat: { flex: 1, alignItems: 'center', gap: 2, paddingHorizontal: spacing.s1 },
  statRule: { borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.divider },
  contact: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, minHeight: 52, paddingHorizontal: spacing.s1 },
  rule: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider },
  pill: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  pillOk: { backgroundColor: colors.successSoft },
  pillWarn: { backgroundColor: colors.warningSoft },
  pillOkText: { color: colors.success, fontFamily: fontFamily.sansExtraBold },
  pillWarnText: { color: colors.warning, fontFamily: fontFamily.sansExtraBold },
  details: { gap: spacing.s3 },
  detail: { gap: 2 },
  group: { gap: spacing.s2 },
  groupTitle: { paddingHorizontal: spacing.s1 },
  menu: { gap: 0, paddingVertical: spacing.s1 },
  confirm: { gap: spacing.s2 },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
    minHeight: 50,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  linkLast: { borderBottomWidth: 0 },
});
