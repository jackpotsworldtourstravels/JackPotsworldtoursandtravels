import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AuthGate, Banner, Button, Card, ListRow, Screen, Text } from '@/components';
import { env } from '@/config/env';
import { COMPANY_LINKS, LEGAL_LINKS, type InfoLink } from '@/features/info/links';
import { useAuthDetour } from '@/features/auth/useReturnTo';
import { useAuth } from '@/providers/AuthProvider';
import { colors, spacing } from '@/theme';
import type { Customer } from '@/types/api';
import { formatLongDate, isISODate } from '@/utils/dates';

function Row({ label, value, note }: { label: string; value: string | null | undefined; note?: string }) {
  if (!value) return null;
  return (
    <View style={styles.field}>
      <Text variant="caption" color="muted">
        {label}
      </Text>
      <Text variant="bodyStrong">
        {value}
        {note ? <Text variant="small" color="muted">{`  ${note}`}</Text> : null}
      </Text>
    </View>
  );
}

function addressOf(c: Customer): string | null {
  const lines = [c.address_line1, c.address_line2, [c.city, c.state].filter(Boolean).join(', '), [c.country, c.postal_code].filter(Boolean).join(' ')].filter(
    (line): line is string => Boolean(line && line.trim()),
  );
  return lines.length ? lines.join('\n') : null;
}

/**
 * The website's information pages: company and legal, as its footer lists them (features/info/links.ts). They are
 * the website's own, opened in an in-app browser so there is one copy to keep correct. Image credits matter here:
 * most of the destination photographs are CC BY or CC BY-SA and require attribution.
 */
function LinkGroup({ title, links }: { title: string; links: readonly InfoLink[] }) {
  return (
    <Card style={styles.about}>
      <Text variant="eyebrow" color="goldInk">
        {title}
      </Text>
      {links.map((link) => (
        <Pressable
          key={link.path}
          onPress={() => void WebBrowser.openBrowserAsync(`${env.apiBaseUrl}${link.path}`)}
          accessibilityRole="link"
          accessibilityLabel={link.label}
          accessibilityHint="Opens in an in-app browser"
          style={styles.link}
        >
          <Text variant="bodyStrong" color="navy800" style={styles.linkText}>
            {link.label}
          </Text>
          <Ionicons name="open-outline" size={18} color={colors.goldInk} />
        </Pressable>
      ))}
    </Card>
  );
}

function AboutLinks() {
  return (
    <>
      <LinkGroup title="About" links={COMPANY_LINKS} />
      <LinkGroup title="Legal" links={LEGAL_LINKS} />
    </>
  );
}

/** A guest has a session but no account. Everything they do is kept for them when they make one. */
function GuestCard() {
  const detour = useAuthDetour();
  return (
    <Card>
      <Text variant="h2" color="navy800" accessibilityRole="header">
        Browsing as a guest
      </Text>
      <Text variant="body" color="ink2">
        Your bookings, wishlist and saved travellers are kept for you on this phone. Create an account, or sign in to the one you have, and they
        come with you to every device.
      </Text>
      <Button title="Create account" onPress={() => detour('/sign-up')} />
      <Button title="Sign in" variant="outline" onPress={() => detour('/sign-in')} />
    </Card>
  );
}

function AccountCard({ customer }: { customer: Customer }) {
  const router = useRouter();
  const birthday = customer.date_of_birth && isISODate(customer.date_of_birth) ? formatLongDate(customer.date_of_birth) : null;
  return (
    <Card>
      <Text variant="h2" color="navy800" accessibilityRole="header">
        {customer.full_name}
      </Text>
      <Row label="Customer code" value={customer.customer_code} />
      <Row label="Email" value={customer.email} note={customer.email ? (customer.email_verified ? 'Verified' : 'Not verified') : undefined} />
      <Row label="Mobile" value={customer.mobile} note={customer.mobile ? (customer.mobile_verified ? 'Verified' : 'Not verified') : undefined} />
      <Row label="Date of birth" value={birthday} />
      <Row label="Gender" value={customer.gender} />
      <Row label="Address" value={addressOf(customer)} />
      <Button title="Edit details" variant="outline" onPress={() => router.push('/account/edit')} />
    </Card>
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
      loading={busy}
      onPress={() => (guest ? setConfirming(true) : void run())}
    />
  );
}

export default function ProfileScreen() {
  const router = useRouter();
  const { customer, status } = useAuth();
  const guest = status === 'guest';

  return (
    <Screen header={{ title: 'Profile' }} scroll bottomInset={false}>
      <AuthGate title="Your profile" message="Sign in to manage your details and see your account.">
        {guest || !customer ? <GuestCard /> : <AccountCard customer={customer} />}

        <Card style={styles.menu}>
          <ListRow icon="briefcase-outline" title="My bookings" subtitle="Upcoming, past and cancelled" onPress={() => router.push('/bookings')} />
          <ListRow icon="card-outline" title="Payments" subtitle="Your payments and refunds" onPress={() => router.push('/payments')} />
          <ListRow icon="heart-outline" title="Wishlist" subtitle="Hotels and tour packages you saved" onPress={() => router.push('/wishlist')} />
          <ListRow icon="people-outline" title="Saved travellers" subtitle="Names and passports for faster booking" onPress={() => router.push('/travellers')} />
          <ListRow icon="help-buoy-outline" title="Help and support" subtitle="Call us, or send a message" onPress={() => router.push('/support')} />
          {guest ? null : (
            <ListRow icon="phone-portrait-outline" title="Where you’re signed in" subtitle="Devices and browsers" onPress={() => router.push('/account/sessions')} />
          )}
          <ListRow icon="trash-outline" title="Delete my account" subtitle="Ask us to delete your account and data" onPress={() => router.push('/account/delete')} last />
        </Card>

        <SignOut guest={guest} />
      </AuthGate>

      <AboutLinks />
      <View>
        <Text variant="caption" color="muted" align="center">
          Version {Constants.expoConfig?.version ?? '—'}
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  field: { gap: 2 },
  menu: { gap: 0 },
  confirm: { gap: spacing.s2 },
  about: { gap: 0 },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
    minHeight: 52,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  linkText: { flex: 1 },
});
