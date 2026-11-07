import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { env } from '@/config/env';
import { SUPPORT_EMAIL, SUPPORT_PHONE, SUPPORT_PHONE_DISPLAY } from '@/features/account/support';
import { useAuthDetour } from '@/features/auth/useReturnTo';
import { useAuth } from '@/providers/AuthProvider';
import { colors, fontFamily, minTouchTarget, radius, spacing } from '@/theme';

import { Logo } from './Logo';
import { Text } from './Text';

/**
 * The website's header actions, from `frontend/assets/js/jw-header.js` and the Home
 * page's header: a wishlist heart, a LOGIN / CREATE pill (the account chip once
 * signed in) and a menu. The menu is the website's full-screen drawer (`.jw-drawer`): five large numbered
 * links in its order, Flights, Hotels, Tour Packages, Gaming Tour Packages and Contact, then "My trips" and
 * "Partner sign in", then the phone and email.
 * The bottom tabs stay: they are how a phone returns to Home, Bookings, Wishlist and
 * Profile, and this header adds the website's own shortcuts on top of them.
 */
export const MENU_ITEMS = [
  { key: 'flights', title: 'Flights', href: '/flights' },
  { key: 'hotels', title: 'Hotels', href: '/hotels' },
  { key: 'packages', title: 'Tour Packages', href: '/packages' },
  { key: 'gaming', title: 'Gaming Tour Packages', href: '/gaming' },
  { key: 'contact', title: 'Contact', href: '/support' },
] as const;

/** The partner portal is the website's own page; the app opens it there rather than rebuilding a B2B sign-in. */
const PARTNER_PATH = '/partner-login.html';

/** The website's drawer: a near-black plate with a gold glow at the top right and a coral one at the bottom left. */
function MenuDrawer({ visible, onClose, onGo, onTrips }: { visible: boolean; onClose: () => void; onGo: (href: (typeof MENU_ITEMS)[number]['href']) => void; onTrips: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.drawer} accessibilityViewIsModal>
        <LinearGradient colors={['rgba(217,178,111,0.16)', 'rgba(217,178,111,0)']} start={{ x: 1, y: 0 }} end={{ x: 0.3, y: 0.5 }} style={StyleSheet.absoluteFill} pointerEvents="none" />
        <LinearGradient colors={['rgba(201,72,47,0.14)', 'rgba(201,72,47,0)']} start={{ x: 0, y: 1 }} end={{ x: 0.7, y: 0.5 }} style={StyleSheet.absoluteFill} pointerEvents="none" />
        <View style={[styles.drawerTop, { paddingTop: insets.top + spacing.s2, paddingHorizontal: spacing.s4 + insets.left }]}>
          <Logo size={54} />
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close menu" hitSlop={8} style={({ pressed }) => [styles.round, pressed && styles.pressed]}>
            <Ionicons name="close" size={22} color={colors.white} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={[styles.drawerBody, { paddingHorizontal: spacing.s4 + insets.left, paddingBottom: spacing.s6 + insets.bottom }]}>
          <View accessibilityRole="menu">
            {MENU_ITEMS.map((item, i) => (
              <Pressable
                key={item.key}
                onPress={() => onGo(item.href)}
                accessibilityRole="button"
                accessibilityLabel={item.title}
                style={({ pressed }) => [styles.bigRow, i === 0 && styles.bigRowFirst, pressed && styles.pressed]}
              >
                <Text variant="caption" color="gold" style={styles.bigNum}>
                  {String(i + 1).padStart(2, '0')}
                </Text>
                <Text variant="display" color="white" style={styles.bigLabel}>
                  {item.title}
                </Text>
                <Ionicons name="arrow-forward" size={22} color={colors.gold} />
              </Pressable>
            ))}
          </View>
          <View style={styles.pills}>
            <Pressable onPress={onTrips} accessibilityRole="button" accessibilityLabel="My trips" style={({ pressed }) => [styles.pill2, pressed && styles.pressed]}>
              <Text variant="caption" color="onDark" chrome style={styles.pill2Text}>
                My trips
              </Text>
            </Pressable>
            <Pressable
              onPress={() => void WebBrowser.openBrowserAsync(`${env.apiBaseUrl}${PARTNER_PATH}`)}
              accessibilityRole="link"
              accessibilityLabel="Partner sign in"
              style={({ pressed }) => [styles.pill2, pressed && styles.pressed]}
            >
              <Text variant="caption" color="onDark" chrome style={styles.pill2Text}>
                Partner sign in
              </Text>
            </Pressable>
          </View>
          <View style={styles.drawerFoot}>
            <Pressable onPress={() => void Linking.openURL(`tel:${SUPPORT_PHONE}`).catch(() => undefined)} accessibilityRole="link" accessibilityLabel={`Call ${SUPPORT_PHONE_DISPLAY}`} style={styles.footLink}>
              <Text variant="small" color="onDark2" style={styles.footText}>
                {SUPPORT_PHONE_DISPLAY}
              </Text>
            </Pressable>
            <Pressable onPress={() => void Linking.openURL(`mailto:${SUPPORT_EMAIL}`).catch(() => undefined)} accessibilityRole="link" accessibilityLabel={`Email ${SUPPORT_EMAIL}`} style={styles.footLink}>
              <Text variant="small" color="onDark2" style={styles.footText}>
                {SUPPORT_EMAIL}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

function IconButton({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={({ pressed }) => [styles.round, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={22} color={colors.white} />
    </Pressable>
  );
}

/** The website's burger (`.jw-hdr__burger`): a 44px ring holding two 1.5px bars, 16.4 and 11.4 wide, 8px apart. */
function BurgerButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel="Menu" hitSlop={4} style={({ pressed }) => [styles.round, pressed && styles.pressed]}>
      <View style={styles.bars}>
        <View style={[styles.bar, { width: 16.4 }]} />
        <View style={[styles.bar, { width: 11.4 }]} />
      </View>
    </Pressable>
  );
}

export function HeaderActions() {
  const router = useRouter();
  const detour = useAuthDetour();
  const { status, customer } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  // A guest has a session but no account: they are offered sign-in like anyone signed out.
  const signedIn = status === 'customer' && customer !== null;
  const initial = (customer?.full_name ?? '').trim().charAt(0).toUpperCase() || '?';

  const go = (href: (typeof MENU_ITEMS)[number]['href']) => {
    setMenuOpen(false);
    router.push(href);
  };

  return (
    <View style={styles.row}>
      <IconButton icon="heart-outline" label="Wishlist" onPress={() => router.push('/wishlist')} />
      {signedIn ? (
        <Pressable
          onPress={() => router.push('/profile')}
          accessibilityRole="button"
          accessibilityLabel="Your profile"
          hitSlop={4}
          style={({ pressed }) => [styles.round, styles.avatar, pressed && styles.pressed]}
        >
          <Text variant="bodyStrong" color="gold" chrome>
            {initial}
          </Text>
        </Pressable>
      ) : (
        <Pressable
          onPress={() => detour('/sign-in')}
          accessibilityRole="button"
          accessibilityLabel="Log in or create an account"
          hitSlop={4}
          style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
        >
          <Ionicons name="person-outline" size={16} color={colors.navy800} />
          <Text variant="caption" color="navy800" chrome style={styles.pillLabel}>
            LOGIN / CREATE
          </Text>
        </Pressable>
      )}
      <BurgerButton onPress={() => setMenuOpen(true)} />

      <MenuDrawer
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        onGo={go}
        onTrips={() => {
          setMenuOpen(false);
          router.push('/bookings');
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2 },
  round: {
    width: minTouchTarget - 4,
    height: minTouchTarget - 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
    backgroundColor: 'rgba(255,255,255,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bars: { width: 16.4, gap: 6.5 },
  bar: { height: 1.5, borderRadius: 2, backgroundColor: colors.white },
  avatar: { borderColor: colors.goldRing, backgroundColor: colors.goldFill },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s1,
    minHeight: minTouchTarget - 4,
    paddingHorizontal: spacing.s3,
    borderRadius: radius.pill,
    backgroundColor: colors.white,
  },
  pillLabel: { letterSpacing: 1.1, fontFamily: fontFamily.sansBold },
  pressed: { opacity: 0.8 },
  drawer: { flex: 1, backgroundColor: colors.night },
  drawerTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: spacing.s2 },
  drawerBody: { paddingTop: spacing.s5, gap: spacing.s6 },
  // `.jw-drawer__big`: Playfair 500, 33px on 33px lines, a hairline under each, 20px above and below.
  bigRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.s4, paddingVertical: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.1)' },
  bigRowFirst: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.1)' },
  bigNum: { width: 26, fontFamily: fontFamily.displayItalic, fontSize: 14, color: colors.gold },
  bigLabel: { flex: 1, fontSize: 33, lineHeight: 33, letterSpacing: -0.66 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s3 },
  pill2: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.s4, borderRadius: radius.pill, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  pill2Text: { fontSize: 12, letterSpacing: 0.96, fontFamily: fontFamily.sansSemiBold },
  drawerFoot: { gap: spacing.s1 },
  footLink: { minHeight: 36, justifyContent: 'center' },
  footText: { fontSize: 13, lineHeight: 19.5 },
});
