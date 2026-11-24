import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components';
import { colors, fontFamily } from '@/theme';

type IconName = keyof typeof Ionicons.glyphMap;

/** The four tabs around the centre button, by route name, in bar order. */
const LEFT: { name: string; label: string; icon: IconName; active: IconName }[] = [
  { name: 'index', label: 'Home', icon: 'home-outline', active: 'home' },
  { name: 'bookings', label: 'Trips', icon: 'ticket-outline', active: 'ticket' },
];
const RIGHT: typeof LEFT = [
  { name: 'wishlist', label: 'Wishlist', icon: 'heart-outline', active: 'heart' },
  { name: 'profile', label: 'Profile', icon: 'person-outline', active: 'person' },
];

const HUMP = 80;
const BUTTON = 58;

/**
 * Home · Trips · [Assistant] · Wishlist · Profile. The Travel Assistant is the raised gold button in the middle: the
 * bar's top edge rises in an arc around it, and it opens the assistant as its own full screen (not a tab), so the
 * chat has the whole height. The active tab gets a gold bar above it, a filled icon and a bold navy label.
 */
export function BrandTabBar({ state, navigateToTab }: BottomTabBarProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const tab = (item: (typeof LEFT)[number]) => {
    const index = state.routes.findIndex((r) => r.name === item.name);
    if (index < 0) return null;
    const route = state.routes[index];
    const focused = state.index === index;
    const onPress = () => {
      if (!focused) navigateToTab(route.key);
    };
    return (
      <Pressable
        key={item.name}
        onPress={onPress}
        accessibilityRole="tab"
        accessibilityState={{ selected: focused }}
        accessibilityLabel={item.label}
        style={({ pressed }) => [styles.tab, pressed && styles.pressed]}
      >
        {focused ? <View style={styles.activeBar} /> : null}
        <Ionicons name={focused ? item.active : item.icon} size={23} color={focused ? colors.primary : colors.textSecondary} />
        <Text variant="caption" chrome color={focused ? 'ink' : 'textSecondary'} style={focused ? styles.labelOn : styles.label} allowFontScaling={false}>
          {item.label}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 10), paddingLeft: insets.left, paddingRight: insets.right }]} accessibilityRole="tablist">
      {LEFT.map(tab)}
      <Pressable
        onPress={() => router.push('/assistant')}
        accessibilityRole="button"
        accessibilityLabel="Travel assistant"
        accessibilityHint="Opens a chat that helps you plan and book"
        style={styles.tab}
      >
        {/* The bar's top edge rising in an arc around the button: the top of a white circle, clipped at the bar's edge. */}
        <View pointerEvents="none" style={styles.humpClip}>
          <View style={styles.hump} />
        </View>
        <View style={styles.assistant}>
          <Ionicons name="chatbubble-ellipses" size={26} color={colors.navy900} />
        </View>
        <Text variant="caption" chrome color="ink" style={[styles.labelOn, styles.assistantLabel]} allowFontScaling={false}>
          Assistant
        </Text>
      </Pressable>
      {RIGHT.map(tab)}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.divider,
    shadowColor: colors.navy900,
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.06,
    shadowRadius: 14,
    elevation: 12,
  },
  tab: { flex: 1, height: 62, alignItems: 'center', justifyContent: 'center', gap: 3 },
  pressed: { opacity: 0.7 },
  activeBar: { position: 'absolute', top: 0, width: 30, height: 3, borderBottomLeftRadius: 3, borderBottomRightRadius: 3, backgroundColor: colors.gold },
  label: { fontFamily: fontFamily.sansSemiBold, fontSize: 11, lineHeight: 14 },
  labelOn: { fontFamily: fontFamily.sansExtraBold, fontSize: 11, lineHeight: 14 },
  humpClip: { position: 'absolute', top: -30, width: HUMP + 40, height: 31, overflow: 'hidden', alignItems: 'center' },
  hump: {
    position: 'absolute',
    top: 0,
    width: HUMP,
    height: HUMP,
    borderRadius: HUMP / 2,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
  },
  assistant: {
    position: 'absolute',
    top: -20,
    width: BUTTON,
    height: BUTTON,
    borderRadius: BUTTON / 2,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.goldInk,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
  },
  assistantLabel: { position: 'absolute', bottom: 9 },
});
