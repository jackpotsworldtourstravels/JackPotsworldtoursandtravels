import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { Banner, Button, Card, PageShell, Text } from '@/components';
import { formatWhen } from '@/features/account/format';
import { useSupportTickets } from '@/features/account/hooks';
import { SUPPORT_ADDRESS, SUPPORT_EMAIL, SUPPORT_HOURS, SUPPORT_PHONE, SUPPORT_PHONE_DISPLAY, SUPPORT_VISITS, ticketStatusLabel } from '@/features/account/support';
import { useAuth } from '@/providers/AuthProvider';
import { colors, spacing } from '@/theme';

/** Open the phone or mail app. A device with neither (a tablet, the web preview) gets a plain sentence, not a dead button. */
function useOpenLink() {
  const [problem, setProblem] = useState<string | null>(null);
  const open = async (url: string, fallback: string) => {
    setProblem(null);
    try {
      await Linking.openURL(url);
    } catch {
      setProblem(fallback);
    }
  };
  return { problem, open };
}

function ContactCard() {
  const { problem, open } = useOpenLink();
  const router = useRouter();
  return (
    <Card style={styles.card}>
      <Text variant="eyebrow" color="goldInk">
        Call us
      </Text>
      <Text variant="body" color="ink2">
        Fastest for anything urgent — a departure inside 24 hours, a schedule change, a name correction.
      </Text>
      <Button
        title={`Call ${SUPPORT_PHONE_DISPLAY}`}
        icon="call-outline"
        onPress={() => void open(`tel:${SUPPORT_PHONE}`, `This device can’t place calls. Please call ${SUPPORT_PHONE_DISPLAY}.`)}
      />
      <Text variant="small" color="muted">
        Hours: {SUPPORT_HOURS}
      </Text>

      <Text variant="eyebrow" color="goldInk" style={styles.gap}>
        Write to us
      </Text>
      <Text variant="body" color="ink2">
        Best when you have documents to attach or want the answer in writing. Include your booking reference if you have one.
      </Text>
      <Button title="Send us a message" variant="outline" icon="chatbubble-ellipses-outline" onPress={() => router.push('/support/new')} />
      <Button
        title="Email us"
        variant="outline"
        icon="mail-outline"
        onPress={() => void open(`mailto:${SUPPORT_EMAIL}`, `This device can’t send email from here. Please write to ${SUPPORT_EMAIL}.`)}
      />
      <Text variant="small" color="muted">
        {SUPPORT_EMAIL}
      </Text>

      <Text variant="eyebrow" color="goldInk" style={styles.gap}>
        Where we are
      </Text>
      <Text variant="body" color="ink2">
        {SUPPORT_ADDRESS}. {SUPPORT_VISITS}
      </Text>
      {problem ? <Banner tone="warning" message={problem} /> : null}
    </Card>
  );
}

/**
 * Requests sent before the app moved to email stay here, readable, with whatever replies they got. Nothing new is
 * created here: new messages go to the team by email (see `new.tsx`), because the website's staff tools no longer
 * answer tickets. Shown only when there are some.
 */
function EarlierRequests() {
  const router = useRouter();
  const tickets = useSupportTickets();

  if (!tickets.isSuccess || tickets.data.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text variant="h2" color="navy800" accessibilityRole="header">
        Earlier requests
      </Text>
      <Text variant="small" color="muted">
        These are requests you sent before. New messages go to our team by email.
      </Text>
      <View style={styles.list}>
        {tickets.data.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => router.push({ pathname: '/support/[id]', params: { id: String(t.id) } })}
            accessibilityRole="button"
            accessibilityLabel={`${t.subject}, ${ticketStatusLabel(t.status)}`}
            style={({ pressed }) => pressed && styles.pressed}
          >
            <Card style={styles.ticket}>
              <View style={styles.ticketText}>
                <Text variant="bodyStrong" color="navy800" numberOfLines={2}>
                  {t.subject}
                </Text>
                <Text variant="small" color="muted">
                  {ticketStatusLabel(t.status)} · updated {formatWhen(t.updated_at)}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.muted} />
            </Card>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/**
 * Help. The company's own contact details are always here (from its website, frontend/contact-us.html), and anyone
 * can send the team a message. Live chat and calling are not in the app: they need a real-time connection the app
 * does not have yet, so nothing here pretends otherwise.
 */
export default function SupportScreen() {
  const { hasSession } = useAuth();
  return (
    <PageShell title="Help and support" crumb="Contact Us" lede="We answer 24 hours a day, 7 days a week.">
      <ContactCard />
      {hasSession ? <EarlierRequests /> : null}
    </PageShell>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.s3 },
  gap: { marginTop: spacing.s2 },
  section: { gap: spacing.s3 },
  list: { gap: spacing.s3 },
  ticket: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3 },
  ticketText: { flex: 1, gap: 2 },
  pressed: { opacity: 0.9 },
});
