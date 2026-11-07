import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { z } from 'zod';

import { engagementApi } from '@/api/endpoints/engagement';
import { Banner, Text } from '@/components';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { colors, fontFamily, radius, spacing } from '@/theme';

import { FINALE } from './copy';

const { newsletter } = FINALE;

/** An address, tidied. Null when it is not one: the server would refuse it anyway, so say so before asking. */
export function parseNewsletterEmail(value: string): string | null {
  const email = value.trim();
  return z.email().safeParse(email).success ? email : null;
}

type Outcome = { kind: 'done' } | { kind: 'failed' } | { kind: 'invalid' } | null;

/**
 * The website's newsletter signup (`#newsletterForm` in index.html, handled in
 * app.js): one field, "Subscribe", "You're subscribed! Watch your inbox for deals."
 * on success and "Something went wrong — please try again." on any failure. The
 * backend only relays the address to the business inbox, so nothing here is
 * stored against the customer, and a second tap never sends a second mail.
 */
export function NewsletterForm() {
  const singleFlight = useSingleFlight();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const submit = () =>
    singleFlight(async () => {
      const address = parseNewsletterEmail(email);
      if (!address) {
        setOutcome({ kind: 'invalid' });
        return;
      }
      setSending(true);
      setOutcome(null);
      try {
        await engagementApi.subscribeNewsletter(address);
        setEmail('');
        setOutcome({ kind: 'done' });
      } catch {
        // The server's own text is never shown: it can name an inbox or a mail fault.
        setOutcome({ kind: 'failed' });
      } finally {
        setSending(false);
      }
    });

  return (
    <View style={styles.wrap}>
      {/* `.cine-news .newsletter-form`: one smoked-glass pill holding the field and a white "Subscribe". */}
      <View style={styles.pill}>
        <TextInput
          value={email}
          onChangeText={(v) => {
            setEmail(v);
            if (outcome) setOutcome(null);
          }}
          placeholder={newsletter.placeholder}
          placeholderTextColor="rgba(255,255,255,0.5)"
          accessibilityLabel={newsletter.label}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
          returnKeyType="send"
          onSubmitEditing={() => void submit()}
          style={styles.input}
        />
        <Pressable
          onPress={() => void submit()}
          disabled={sending}
          accessibilityRole="button"
          accessibilityLabel={newsletter.button}
          accessibilityState={{ busy: sending, disabled: sending }}
          style={({ pressed }) => [styles.subscribe, pressed && styles.pressed]}
        >
          <Text variant="bodyStrong" color="ink" chrome style={styles.subscribeText}>
            {sending ? 'Subscribing…' : newsletter.button}
          </Text>
        </Pressable>
      </View>
      {outcome?.kind === 'done' ? <Banner tone="success" message={newsletter.success} /> : null}
      {outcome?.kind === 'failed' ? <Banner tone="error" message={newsletter.error} /> : null}
      {outcome?.kind === 'invalid' ? <Banner tone="error" message="Enter a valid email address." /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.s3 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 48,
    paddingVertical: 12,
    paddingHorizontal: 18,
    color: colors.white,
    fontFamily: fontFamily.sans,
    fontSize: 16,
  },
  subscribe: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 22,
    borderRadius: radius.pill,
    backgroundColor: colors.white,
  },
  subscribeText: { fontFamily: fontFamily.sansBold, fontSize: 15 },
  pressed: { backgroundColor: colors.goldLight },
});
