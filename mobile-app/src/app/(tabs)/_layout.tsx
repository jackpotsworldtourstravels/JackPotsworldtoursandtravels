import { Tabs } from 'expo-router/js-tabs';

import { BrandTabBar } from '@/features/navigation/BrandTabBar';

/**
 * Home · Trips · [Assistant] · Wishlist · Profile, drawn by BrandTabBar. The Assistant in the middle opens its own
 * full screen (`/assistant`), so it is not a tab here. Explore keeps its route (Home's "See all" opens it) but has no
 * place in the bar.
 */
export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <BrandTabBar {...props} />}>
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="bookings" options={{ title: 'Trips' }} />
      <Tabs.Screen name="wishlist" options={{ title: 'Wishlist' }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
      <Tabs.Screen name="explore" options={{ title: 'Explore' }} />
    </Tabs>
  );
}
