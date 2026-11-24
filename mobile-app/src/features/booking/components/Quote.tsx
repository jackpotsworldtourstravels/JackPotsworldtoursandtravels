import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Tag } from '@/components/layout';
import { Text } from '@/components/Text';
import { TextField } from '@/components/TextField';
import { useCoupons } from '@/features/discovery/hooks';
import { colors, fontFamily, radius, spacing } from '@/theme';
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

/**
 * A coupon code box, drawn as a gold-dashed panel. The server decides whether a code applies; the result comes back in
 * the quote. With `product`, the codes live for that kind of booking are offered as chips to apply with one tap (the
 * same list the Offers screen shows). Once a code is applied it shows as a green confirmation with Remove.
 */
export function CouponField({
  applied,
  error,
  busy,
  onApply,
  onClear,
  product,
}: {
  /** The code the current quote was asked with, if any. */
  applied: string | undefined;
  error?: string | null;
  busy?: boolean;
  onApply: (code: string) => void;
  onClear: () => void;
  product?: 'hotel' | 'package';
}) {
  const [text, setText] = useState(applied ?? '');
  const normalised = normaliseCoupon(text);
  const live = useCoupons(product ?? 'hotel');
  const suggestions = product ? (live.data ?? []).filter((c) => c.code !== applied).slice(0, 4) : [];

  return (
    <View style={styles.couponBox}>
      <View style={styles.couponHead}>
        <Ionicons name="pricetag-outline" size={18} color={colors.goldInk} />
        <Text variant="bodyStrong" color="ink" style={styles.label}>
          Have a coupon code?
        </Text>
      </View>
      {applied && !error ? (
        <View style={styles.couponApplied} accessibilityLiveRegion="polite">
          <View style={styles.couponTick}>
            <Ionicons name="checkmark" size={15} color={colors.white} />
          </View>
          <Text variant="bodyStrong" color="success" style={styles.label}>
            {applied} applied
          </Text>
          <Button
            title="Remove"
            variant="ghost"
            size="sm"
            fullWidth={false}
            onPress={() => {
              setText('');
              onClear();
            }}
          />
        </View>
      ) : (
        <>
          <View style={styles.couponRow}>
            <View style={styles.label}>
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
            </View>
            <Button
              title="Apply code"
              variant="outline"
              fullWidth={false}
              loading={busy}
              disabled={!normalised || normalised === applied}
              onPress={() => normalised && onApply(normalised)}
              style={styles.couponApply}
            />
          </View>
          {applied ? (
            <Button
              title="Remove"
              variant="ghost"
              size="sm"
              fullWidth={false}
              onPress={() => {
                setText('');
                onClear();
              }}
            />
          ) : null}
        </>
      )}
      {suggestions.length > 0 ? (
        <View style={styles.couponChips}>
          {suggestions.map((c) => (
            <Pressable
              key={c.code}
              onPress={() => {
                setText(c.code);
                onApply(c.code);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Apply ${c.code}, ${c.title}`}
              style={({ pressed }) => [styles.couponChip, pressed && styles.stale]}
            >
              <Text variant="caption" chrome color="goldInk" style={styles.couponChipText}>
                {c.code}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
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
  couponBox: {
    gap: spacing.s3,
    padding: spacing.s4,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.gold,
    backgroundColor: colors.surface,
  },
  couponHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2 },
  couponRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.s2 },
  couponApply: { marginBottom: 2 },
  couponApplied: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2, padding: spacing.s2, paddingLeft: spacing.s3, borderRadius: radius.md, backgroundColor: colors.successSoft },
  couponTick: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.success, alignItems: 'center', justifyContent: 'center' },
  couponChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  couponChip: { minHeight: 34, borderRadius: 10, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.gold, backgroundColor: '#FFFCF4', paddingHorizontal: spacing.s3, justifyContent: 'center' },
  couponChipText: { fontFamily: fontFamily.sansExtraBold, letterSpacing: 0.6 },
});
