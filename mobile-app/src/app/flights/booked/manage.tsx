import { Ionicons } from '@expo/vector-icons';
import { Redirect, useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BottomSheet, Button, Card, ListRow, Screen, Text } from '@/components';
import { sampleFlightBooking } from '@/features/flights/preview/sampleBooking';
import { SampleNotice } from '@/features/flights/preview/ui';
import { colors, fontFamily, spacing } from '@/theme';
import { addDays, formatShortDate } from '@/utils/dates';

type IconName = keyof typeof Ionicons.glyphMap;

interface Option {
  icon: IconName;
  title: string;
  subtitle: string;
  /** What the live app will do here, said in the preview sheet. */
  explain: string;
  href?: Href;
  danger?: boolean;
}

/**
 * MANAGE A FLIGHT BOOKING (preview). Everything a customer can change after booking, each with what it costs or when
 * it opens. In the preview, the rows open a sheet saying what the live app will do; cancelling has its own screen.
 */
export default function FlightManageScreen() {
  const router = useRouter();
  const [open, setOpen] = useState<Option | null>(null);
  if (!__DEV__) return <Redirect href="/flights" />;
  const booking = sampleFlightBooking();
  const checkinOpens = addDays(booking.segments[0].date, -2);

  const groups: { title: string; options: Option[] }[] = [
    {
      title: 'Before you fly',
      options: [
        { icon: 'phone-portrait-outline', title: 'Web check-in', subtitle: `Opens ${formatShortDate(checkinOpens)}, 48 hours before departure`, explain: 'Check in for every traveller on this booking and get boarding passes in the app.' },
        { icon: 'grid-outline', title: 'Choose or change seats', subtitle: '2 seats picked on trip 1 · none on trip 2', explain: 'Opens the seat map for each flight, with the price of any seat change.' },
        { icon: 'restaurant-outline', title: 'Add meals', subtitle: 'Up to 24 hours before departure', explain: 'Opens the meal menu for each traveller and flight.' },
        { icon: 'briefcase-outline', title: 'Add baggage', subtitle: 'Cheaper now than at the airport', explain: 'Adds check-in weight per traveller, priced by the airline.' },
        { icon: 'accessibility-outline', title: 'Special assistance', subtitle: 'Free · wheelchair, medical, infant', explain: 'Sends wheelchair, medical or bassinet requests to the airline.' },
      ],
    },
    {
      title: 'Changes',
      options: [
        { icon: 'calendar-outline', title: 'Change date or flight', subtitle: 'Airline fee + fare difference', explain: 'Shows other flights on the dates you choose, with the change fee and fare difference before you pay.' },
        { icon: 'person-outline', title: 'Correct a name', subtitle: 'Spelling fixes are usually free', explain: 'Sends a name correction to the airline. A different person needs a new ticket.' },
        { icon: 'document-text-outline', title: 'Invoice and GST receipt', subtitle: 'For expenses and GST credit', explain: 'Downloads the invoice, with your GST details if you added them.' },
      ],
    },
  ];

  return (
    <Screen header={{ title: 'Manage booking', subtitle: booking.ref, back: true, tone: 'light' }} scroll>
      <SampleNotice compact />
      {groups.map((g) => (
        <View key={g.title} style={styles.group}>
          <Text variant="caption" chrome color="textSecondary" style={styles.kicker}>
            {g.title.toUpperCase()}
          </Text>
          <Card style={styles.card}>
            {g.options.map((o, i) => (
              <ListRow key={o.title} icon={o.icon} title={o.title} subtitle={o.subtitle} onPress={() => setOpen(o)} last={i === g.options.length - 1} />
            ))}
          </Card>
        </View>
      ))}
      <View style={styles.group}>
        <Text variant="caption" chrome color="textSecondary" style={styles.kicker}>
          CANCEL
        </Text>
        <Card style={styles.card}>
          <ListRow icon="close-circle-outline" title="Cancel flights" subtitle="See your refund before you confirm" tone="danger" onPress={() => router.push('/flights/booked/cancel')} last />
        </Card>
      </View>

      <BottomSheet
        visible={open !== null}
        title={open?.title ?? ''}
        onClose={() => setOpen(null)}
        footer={
          <Button
            title="Ask our team"
            icon="chatbubble-ellipses-outline"
            onPress={() => {
              setOpen(null);
              router.push('/assistant');
            }}
          />
        }
      >
        <View style={styles.sheet}>
          <Text variant="body" color="ink">
            {open?.explain}
          </Text>
          <View style={styles.soon}>
            <Ionicons name="time-outline" size={16} color={colors.goldInk} />
            <Text variant="small" color="ink2" style={styles.flex}>
              This opens with live flight booking. Until then, our team makes these changes for you.
            </Text>
          </View>
        </View>
      </BottomSheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  kicker: { fontFamily: fontFamily.sansExtraBold, letterSpacing: 0.6, paddingHorizontal: spacing.s1 },
  group: { gap: spacing.s2 },
  card: { paddingVertical: 0 },
  sheet: { gap: spacing.s3 },
  soon: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2, backgroundColor: '#FFFCF4', borderRadius: 12, borderWidth: 1, borderColor: '#F1D9A6', padding: spacing.s3 },
});
