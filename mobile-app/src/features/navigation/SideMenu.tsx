import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useRouter, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Logo, Text } from '@/components';
import { env } from '@/config/env';
import { useAuthDetour } from '@/features/auth/useReturnTo';
import { COMPANY_LINKS, LEGAL_LINKS } from '@/features/info/links';
import { useAuth } from '@/providers/AuthProvider';
import { colors, fontFamily, spacing } from '@/theme';

type IconName = keyof typeof Ionicons.glyphMap;

const WIDTH = 314;

interface Item {
  label: string;
  icon: IconName;
  href?: Href;
  url?: string;
}

const MAIN: Item[] = [
  { label: 'Home', icon: 'home-outline', href: '/' },
  { label: 'My trips', icon: 'ticket-outline', href: '/bookings' },
  { label: 'Wishlist', icon: 'heart-outline', href: '/wishlist' },
  { label: 'Offers and coupons', icon: 'pricetag-outline', href: '/offers' },
  { label: 'Saved travellers', icon: 'people-outline', href: '/travellers' },
  { label: 'Payments and refunds', icon: 'card-outline', href: '/payments' },
  { label: 'Profile', icon: 'person-outline', href: '/profile' },
];

const about = COMPANY_LINKS.find((l) => l.label === 'About Us');
const terms = LEGAL_LINKS.find((l) => l.label.includes('Terms'));
const MORE: Item[] = [
  { label: 'Help and support', icon: 'help-circle-outline', href: '/support' },
  ...(about ? [{ label: 'About us', icon: 'information-circle-outline' as IconName, url: about.path }] : []),
  ...(terms ? [{ label: 'Terms and policies', icon: 'document-text-outline' as IconName, url: terms.path }] : []),
  // Development builds only (never in a release, never under test): loaders, sample flight screens and components.
  ...(__DEV__ && process.env.NODE_ENV !== 'test' ? [{ label: 'Developer previews', icon: 'construct-outline' as IconName, href: '/dev/gallery' as Href }] : []),
];

/**
 * The ≡ menu on Home: the logo, who is signed in, everything in the app in one list, the website's information
 * pages, and Log out. It slides in from the left over a dimmed Home; tapping outside or the X closes it. A guest sees
 * "Log in or create an account" where an account sees Log out.
 */
export function SideMenu({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const detour = useAuthDetour();
  const { status, customer, signOut } = useAuth();
  const isCustomer = status === 'customer' && customer;
  const [mounted, setMounted] = useState(visible);
  const [progress] = useState(() => new Animated.Value(0));
  // Mount as soon as it is asked to open (set during render, not in an effect); unmount once the slide-out finishes.
  if (visible && !mounted) setMounted(true);

  useEffect(() => {
    Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? 260 : 200,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
  }, [progress, visible]);

  const go = (item: Item) => {
    onClose();
    if (item.url) void WebBrowser.openBrowserAsync(`${env.apiBaseUrl}${item.url}`);
    else if (item.href) router.push(item.href);
  };

  const initials = isCustomer
    ? customer.full_name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0]?.toUpperCase())
        .join('')
    : null;

  const row = (item: Item, quiet = false) => (
    <Pressable
      key={item.label}
      onPress={() => go(item)}
      accessibilityRole={item.url ? 'link' : 'button'}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <Ionicons name={item.icon} size={20} color={quiet ? colors.onDark2 : colors.goldLight} />
      <Text variant="body" chrome color={quiet ? 'onDark2' : 'onDark'} style={quiet ? styles.rowTextQuiet : styles.rowText}>
        {item.label}
      </Text>
    </Pressable>
  );

  return (
    <Modal visible={mounted} transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, { opacity: progress }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close menu" />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        style={[
          styles.panel,
          { paddingTop: insets.top + spacing.s3, paddingBottom: insets.bottom + spacing.s4, transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [-WIDTH - 20, 0] }) }] },
        ]}
      >
        <View style={styles.top}>
          <Logo size={108} />
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close menu" style={styles.close}>
            <Ionicons name="close" size={20} color={colors.white} />
          </Pressable>
        </View>

        <Pressable
          onPress={() => (isCustomer ? go({ label: 'Profile', icon: 'person-outline', href: '/profile' }) : (onClose(), detour('/sign-in')))}
          accessibilityRole="button"
          style={({ pressed }) => [styles.who, pressed && styles.rowPressed]}
        >
          <View style={styles.avatar}>
            {initials ? (
              <Text variant="h3" chrome color="navy900">
                {initials}
              </Text>
            ) : (
              <Ionicons name="person" size={20} color={colors.navy900} />
            )}
          </View>
          <View style={styles.flex}>
            <Text variant="bodyStrong" color="white" numberOfLines={1}>
              {isCustomer ? customer.full_name : 'Browsing as a guest'}
            </Text>
            <Text variant="caption" color="onDark2" numberOfLines={1}>
              {isCustomer ? (customer.email ?? customer.mobile ?? '') : 'Log in to keep your trips on every device'}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.onDark2} />
        </Pressable>

        <ScrollView style={styles.flex} contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
          {MAIN.map((i) => row(i))}
          <View style={styles.rule} />
          {MORE.map((i) => row(i, true))}
        </ScrollView>

        {isCustomer ? (
          <Pressable
            onPress={() => {
              onClose();
              void signOut();
            }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.out, pressed && styles.rowPressed]}
          >
            <Ionicons name="log-out-outline" size={20} color="#F2B8A6" />
            <Text variant="bodyStrong" chrome style={styles.outText}>
              Log out
            </Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={() => {
              onClose();
              detour('/sign-in');
            }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.login, pressed && styles.rowPressed]}
          >
            <Text variant="bodyStrong" chrome color="navy900">
              Log in or create an account
            </Text>
          </Pressable>
        )}
        <Text variant="caption" color="onDark2" align="center" style={styles.version}>
          Version {Constants.expoConfig?.version ?? '—'}
        </Text>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  scrim: { backgroundColor: 'rgba(7, 17, 31, 0.62)' },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: WIDTH,
    backgroundColor: colors.navy900,
    borderTopRightRadius: 28,
    borderBottomRightRadius: 28,
    paddingHorizontal: spacing.s3,
    shadowColor: '#000',
    shadowOffset: { width: 12, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 30,
    elevation: 24,
  },
  top: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingLeft: spacing.s1 },
  close: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.navy700, alignItems: 'center', justifyContent: 'center' },
  who: { marginTop: spacing.s3, backgroundColor: colors.navy800, borderRadius: 18, padding: spacing.s3, flexDirection: 'row', alignItems: 'center', gap: spacing.s3 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.gold, alignItems: 'center', justifyContent: 'center' },
  list: { paddingVertical: spacing.s3, gap: 2 },
  row: { minHeight: 48, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: spacing.s3 },
  rowPressed: { backgroundColor: colors.navy700 },
  rowText: { fontFamily: fontFamily.sansSemiBold, fontSize: 15 },
  rowTextQuiet: { fontFamily: fontFamily.sansSemiBold, fontSize: 14 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.navy600, marginVertical: spacing.s2, marginHorizontal: spacing.s3 },
  out: { minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: colors.navy600, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: spacing.s3 },
  outText: { color: '#F2B8A6' },
  login: { minHeight: 48, borderRadius: 14, backgroundColor: colors.gold, alignItems: 'center', justifyContent: 'center' },
  version: { marginTop: spacing.s3 },
});
