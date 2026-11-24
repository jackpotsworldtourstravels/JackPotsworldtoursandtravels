import { Redirect, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Accordion,
  Button,
  Card,
  CardSkeleton,
  CircleLoader,
  EmptyState,
  ListSkeleton,
  LoadingState,
  ErrorState,
  FieldCard,
  FieldDivider,
  FieldSplit,
  GoldBadge,
  ListRow,
  LocationPairField,
  PriceTag,
  RatingBadge,
  Screen,
  SearchingScreen,
  Section,
  SegmentedControl,
  ServiceTile,
  ShortcutTile,
  StatusPill,
  StepIndicator,
  StickyTabs,
  TakeoffLoader,
  Text,
  UnavailableState,
} from '@/components';
import { Chip, SectionHeader, Tag } from '@/components/layout';
import { colors, spacing } from '@/theme';

/**
 * DEVELOPMENT ONLY: every UI component and variant on one page, for visual QA of the design system.
 * Release builds redirect home; nothing links here.
 */
export default function ComponentGallery() {
  const router = useRouter();
  const [searching, setSearching] = useState(false);
  // The searching screen closes itself after 4 seconds here, as a real search would when its answer arrives.
  useEffect(() => {
    if (!searching) return;
    const t = setTimeout(() => setSearching(false), 4000);
    return () => clearTimeout(t);
  }, [searching]);
  const [seg, setSeg] = useState<'a' | 'b' | 'c'>('b');
  const [tab, setTab] = useState<'o' | 'r' | 'p'>('o');
  if (!__DEV__) return <Redirect href="/" />;
  const noop = () => undefined;
  return (
    <Screen header={{ title: 'Component gallery', subtitle: 'Development build only', back: true }} scroll>
      <Section title="Loading">
        <Button title="Show the searching screen (4 s)" icon="airplane-outline" onPress={() => setSearching(true)} />
        <Text variant="small" color="textSecondary">
          Take-off, for a screen or section loading:
        </Text>
        <LoadingState message="Loading your trips…" />
        <View style={styles.navyStage}>
          <TakeoffLoader width={220} tone="onDark" label="Confirming payment" />
          <Text variant="small" color="onDark2" align="center">
            On navy: payment confirmation
          </Text>
        </View>
        <Text variant="small" color="textSecondary">
          Circle, for buttons and small spots:
        </Text>
        <View style={styles.circles}>
          <CircleLoader size={16} />
          <CircleLoader size={24} />
          <CircleLoader size={36} />
          <View style={styles.navyDot}>
            <CircleLoader size={24} tone="onDark" />
          </View>
        </View>
        <Button title="Pay ₹32,256" loading onPress={noop} />
        <Text variant="small" color="textSecondary">
          Results while a filter or sort refreshes them:
        </Text>
        <ListSkeleton count={2} label="Finding stays…" />
        <SearchingScreen visible={searching} title="Finding the best stays in Hyderabad" subtitle="25 Nov – 26 Nov · 1 Room · 2 Guests" onCancel={() => setSearching(false)} />
      </Section>

      <Section title="Flight previews (sample data)">
        <Button title="Booked flight" variant="outline" icon="airplane-outline" onPress={() => router.push('/flights/booked/trip')} />
        <Button title="E-ticket" variant="outline" icon="ticket-outline" onPress={() => router.push('/flights/booked/ticket')} />
        <Button title="Manage booking" variant="outline" icon="create-outline" onPress={() => router.push('/flights/booked/manage')} />
        <Button title="Cancel flights" variant="outline" icon="close-circle-outline" onPress={() => router.push('/flights/booked/cancel')} />
      </Section>

      <Section title="Type scale">
        <Text variant="hero">HYD 28</Text>
        <Text variant="display">Display 24</Text>
        <Text variant="h1">Title 20</Text>
        <Text variant="h2">Screen title 18</Text>
        <Text variant="h3">Section 16</Text>
        <Text variant="body">Body 14 regular</Text>
        <Text variant="small" color="textSecondary">
          Secondary 13
        </Text>
        <Text variant="label" color="textSecondary">
          Field label 11
        </Text>
      </Section>

      <Section title="Buttons">
        <Button title="Search flights" caps onPress={noop} />
        <Button title="Secondary" variant="secondary" onPress={noop} />
        <Button title="Outline" variant="outline" onPress={noop} />
        <Button title="Text action" variant="ghost" fullWidth={false} onPress={noop} />
        <Button title="Loading" loading onPress={noop} />
        <Button title="Danger" variant="danger" icon="trash-outline" onPress={noop} />
      </Section>

      <Section title="Selection">
        <SegmentedControl
          options={[
            { value: 'a', label: 'One Way' },
            { value: 'b', label: 'Round Trip' },
            { value: 'c', label: 'Multi-City' },
          ]}
          value={seg}
          onChange={setSeg}
        />
        <View style={styles.row}>
          <Chip label="Selected" selected onPress={noop} />
          <Chip label="Free cancellation" onPress={noop} />
        </View>
        <View style={styles.row}>
          <Tag label="Neutral" />
          <Tag label="Success" tone="success" />
          <Tag label="Gold" tone="gold" />
          <GoldBadge label="3N / 4D" />
        </View>
      </Section>

      <Card flush>
        <View style={styles.row}>
          <ServiceTile icon="airplane-outline" label="Flights" onPress={noop} />
          <ServiceTile icon="bed-outline" label="Hotels" onPress={noop} divider />
          <ServiceTile icon="map-outline" label="Holiday Packages" onPress={noop} divider />
        </View>
      </Card>
      <Card flush>
        <View style={styles.row}>
          <ShortcutTile icon="ticket-outline" label="My Bookings" onPress={noop} />
          <ShortcutTile icon="heart-outline" label="Wishlist" onPress={noop} />
          <ShortcutTile icon="people-outline" label="Saved Travellers" onPress={noop} />
          <ShortcutTile icon="headset-outline" label="Support" onPress={noop} />
        </View>
      </Card>

      <Card flush>
        <LocationPairField
          from={<FieldCard label="From" value="HYD" sub="Hyderabad · Rajiv Gandhi International" size="lg" onPress={noop} />}
          to={<FieldCard label="To" value="DEL" sub="Delhi · Indira Gandhi International" size="lg" onPress={noop} />}
          onSwap={noop}
        />
        <FieldDivider inset={false} />
        <FieldSplit>
          <FieldCard label="Departure" value="28 Nov" sub="Saturday" onPress={noop} />
          <FieldCard label="Return" placeholder="Add return" onPress={noop} />
        </FieldSplit>
      </Card>

      <Section title="Money, rating, status">
        <View style={styles.row}>
          <PriceTag amount="12500.00" unit="per night" note="+ taxes" />
          <PriceTag amount="21900.00" unit="per person" lead="Starting" align="right" />
        </View>
        <View style={styles.row}>
          <RatingBadge value="4.6" />
          <RatingBadge value={null} />
          <StatusPill label="Confirmed" tone="success" icon="checkmark" />
          <StatusPill label="Payment pending" tone="warning" icon="time-outline" />
          <StatusPill label="Cancelled" tone="danger" />
        </View>
      </Section>

      <StickyTabs
        tabs={[
          { value: 'o', label: 'Overview' },
          { value: 'r', label: 'Rooms' },
          { value: 'p', label: 'Policies' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <StepIndicator steps={['Review', 'Travellers', 'Payment']} current={1} />
      <Card>
        <Accordion title="Cancellation policy" initiallyOpen>
          <Text variant="body" color="textSecondary">
            Free cancellation up to 48 hours before check-in.
          </Text>
        </Accordion>
        <Accordion title="Meal plans" last>
          <Text variant="body">Room only</Text>
        </Accordion>
      </Card>
      <Card>
        <ListRow icon="person-outline" title="Personal details" onPress={noop} />
        <ListRow icon="trash-outline" title="Delete account" tone="danger" onPress={noop} last />
      </Card>
      <SectionHeader title="Popular Destinations" actionLabel="View All" onAction={noop} />
      <CardSkeleton />
      <EmptyState title="No bookings yet" message="Your trips will appear here." icon="ticket-outline" actionLabel="Search hotels" onAction={noop} />
      <ErrorState onRetry={noop} />
      <UnavailableState title="Live fares aren't available yet" message="Our travel desk can price this trip for you." actionLabel="Ask our travel desk" onAction={noop} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.s2 },
  navyStage: { backgroundColor: colors.navy900, borderRadius: 18, padding: spacing.s4, alignItems: 'center', gap: spacing.s2 },
  circles: { flexDirection: 'row', alignItems: 'center', gap: spacing.s4 },
  navyDot: { backgroundColor: colors.navy900, borderRadius: 12, padding: spacing.s2 },
});
