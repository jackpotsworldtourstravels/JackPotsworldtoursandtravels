import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Tag } from '@/components/layout';
import { Text } from '@/components/Text';
import { TextField } from '@/components/TextField';
import { colors, radius, spacing } from '@/theme';
import type { Quote } from '@/types/booking';
import { formatMoney } from '@/utils/money';

import { normaliseCoupon } from '../hotelRequest';

/**
 * INDICATIVE versus QUOTED, the distinction the whole booking flow turns on.
 *
 * A catalogue price ("from ₹12,500 a night", a departure's per-person price) is
 * indicative: a figure from the listing, not a promise for any particular dates
 * or party. A QUOTE is the server pricing these exact choices (room, dates,
 * guests, coupon) with taxes. And even a quote is re-priced when the booking is
 * created. So the app says "Indicative" wherever it shows a catalogue price, and
 * shows a quote only in the card below, under its own heading.
 */
export function IndicativeNotice({ what }: { what: 'rate' | 'price' }) {
  return (
    <Banner
      tone="info"
      message={`Indicative ${what}: taken from our listing, before dates, guests and taxes. You’ll see a price our server confirms for your choices before you book.`}
    />
  );
}

const signed = (amount: string, currency: string) => {
  const money = formatMoney(amount, { currency });
  // A discount arrives as "-3750.00": show a true minus sign.
  return money.startsWith('-') ? `−${money.slice(1)}` : money;
};

/** The server's itemised price for the current choices. Amounts are shown exactly as the backend sent them. */
export function QuoteSummary({
  quote,
  stale = false,
  heading = 'Your quote',
}: {
  quote: Pick<Quote, 'currency' | 'lines' | 'total_amount' | 'coupon_code' | 'coupon_title'>;
  /** True while a newer quote is loading: the figures on screen are the previous ones. */
  stale?: boolean;
  heading?: string;
}) {
  return (
    <Card style={[styles.card, stale && styles.stale]}>
      <View style={styles.head}>
        <Text variant="eyebrow" color="goldInk">
          {heading}
        </Text>
        <Tag label={stale ? 'Updating…' : 'Priced by our server'} tone={stale ? 'neutral' : 'success'} />
      </View>
      {quote.lines.map((line, i) => (
        <View key={`${line.label}-${i}`} style={styles.row}>
          <Text variant="body" color="ink2" style={styles.label}>
            {line.label}
          </Text>
          <Text variant="bodyStrong" color={line.amount.startsWith('-') ? 'success' : 'ink'}>
            {signed(line.amount, quote.currency)}
          </Text>
        </View>
      ))}
      <View style={styles.rule} />
      <View style={styles.row}>
        <Text variant="title" color="navy800" style={styles.label}>
          Total to pay
        </Text>
        <Text variant="h3" color="navy800">
          {formatMoney(quote.total_amount, { currency: quote.currency })}
        </Text>
      </View>
      {quote.coupon_code ? (
        <View style={styles.coupon}>
          <Ionicons name="pricetag" size={16} color={colors.success} />
          <Text variant="small" color="success" style={styles.label}>
            {quote.coupon_title ? `${quote.coupon_code}: ${quote.coupon_title}` : `${quote.coupon_code} applied`}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

/** A coupon code box. The server decides whether a code applies; the result comes back in the quote. */
export function CouponField({
  applied,
  error,
  busy,
  onApply,
  onClear,
}: {
  /** The code the current quote was asked with, if any. */
  applied: string | undefined;
  error?: string | null;
  busy?: boolean;
  onApply: (code: string) => void;
  onClear: () => void;
}) {
  const [text, setText] = useState(applied ?? '');
  const normalised = normaliseCoupon(text);

  return (
    <View style={styles.couponBox}>
      <TextField
        label="Coupon code (optional)"
        value={text}
        onChangeText={setText}
        autoCapitalize="characters"
        autoCorrect={false}
        placeholder="For example STAYMORE"
        error={error ?? undefined}
        maxLength={40}
        returnKeyType="done"
        onSubmitEditing={() => normalised && onApply(normalised)}
      />
      <View style={styles.couponActions}>
        <Button
          title="Apply code"
          variant="outline"
          fullWidth={false}
          loading={busy}
          disabled={!normalised || normalised === applied}
          onPress={() => normalised && onApply(normalised)}
        />
        {applied ? (
          <Button
            title="Remove"
            variant="ghost"
            fullWidth={false}
            onPress={() => {
              setText('');
              onClear();
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.s3 },
  stale: { opacity: 0.6 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.s3 },
  row: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.s3 },
  label: { flex: 1 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  coupon: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s2,
    padding: spacing.s3,
    borderRadius: radius.md,
    backgroundColor: colors.successSoft,
  },
  couponBox: { gap: spacing.s2 },
  couponActions: { flexDirection: 'row', gap: spacing.s2, alignItems: 'center' },
});
