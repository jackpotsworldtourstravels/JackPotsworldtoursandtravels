import { Ionicons } from '@expo/vector-icons';
import { Children, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { PARTY_LIMITS, normaliseParty, partySummary, type Party } from '@/features/search/party';
import { colors, fontFamily, radius, spacing } from '@/theme';
import { formatShortDate, parseISODate, type ISODate } from '@/utils/dates';

import { BottomSheet } from './BottomSheet';
import { Button } from './Button';
import { CalendarScreen } from './CalendarScreen';
import { Text } from './Text';
import { FieldCard } from './ui';

type IconName = keyof typeof Ionicons.glyphMap;

/**
 * A form field that opens a picker, drawn as the website's booking-card tile (`.search-card` fields):
 * a small upper-case label, the value in bold, an optional muted line under it (the airport's name),
 * the icon at the left and a chevron at the right, on #F6F5F2 with a 1px edge and 12px corners.
 * The accessible name is still "Label: value".
 */
export function FieldButton({
  label,
  value,
  sub,
  placeholder,
  icon,
  onPress,
  testID,
  chevron = true,
  appearance = 'tile',
}: {
  label: string;
  value?: string;
  /** A second, muted line under the value. */
  sub?: string;
  /** The website's date tile has a calendar icon and no chevron. */
  chevron?: boolean;
  /**
   * `tile` is the booking card's field (grey, label inside). `field` is a service page's form field: the label above in
   * tracked capitals and a white 12px-cornered input, matching the text fields beside it.
   */
  appearance?: 'tile' | 'field';
  placeholder?: string;
  icon: IconName;
  onPress: () => void;
  testID?: string;
}) {
  if (appearance === 'field') {
    return (
      <View style={styles.formField}>
        <Text variant="caption" color="textSecondary" style={styles.formLabel}>
          {label}
        </Text>
        <Pressable
          testID={testID}
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${value ?? placeholder ?? 'not set'}`}
          accessibilityHint="Opens a picker"
          style={({ pressed }) => [styles.formBox, pressed && styles.pressed]}
        >
          <Ionicons name={icon} size={20} color={colors.link} />
          <Text variant="body" color={value ? "ink" : "textDisabled"} numberOfLines={1} style={styles.formValue}>
            {value ?? placeholder}
          </Text>
          {chevron ? <Ionicons name="chevron-down" size={14} color={colors.textSecondary} /> : null}
        </Pressable>
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value ?? placeholder ?? 'not set'}`}
      accessibilityHint="Opens a picker"
      style={({ pressed }) => [styles.box, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={20} color={colors.link} />
      <View style={styles.tileText}>
        <Text variant="caption" color="textSecondary" chrome numberOfLines={1} style={styles.tileLabel}>
          {label.toUpperCase()}
        </Text>
        <Text variant="bodyStrong" color={value ? "ink" : "textDisabled"} numberOfLines={1} style={styles.value}>
          {value ?? placeholder}
        </Text>
        {sub ? (
          <Text variant="small" color="muted" numberOfLines={1} style={styles.tileSub}>
            {sub}
          </Text>
        ) : null}
      </View>
      {chevron ? <Ionicons name="chevron-down" size={14} color={colors.textSecondary} /> : null}
    </Pressable>
  );
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "28 Nov": the big value of a date field card. */
export function dayMonth(value: ISODate): string {
  return formatShortDate(value).replace(/^\w+,\s*/, '');
}

/** "Saturday, 2026": the line under a date field card's value. */
export function weekdayYear(value: ISODate): string {
  const d = parseISODate(value);
  return `${WEEKDAYS[d.getDay()]}, ${d.getFullYear()}`;
}

/** One date, picked from the full-screen calendar. */
export function DatePickerField({
  label,
  value,
  min,
  max,
  onChange,
  today,
}: {
  label: string;
  value: ISODate;
  min: ISODate;
  max: ISODate;
  onChange: (date: ISODate) => void;
  today?: ISODate;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <FieldButton label={label} value={formatShortDate(value)} icon="calendar-outline" chevron={false} onPress={() => setOpen(true)} />
      <CalendarScreen mode="single" visible={open} title={label} value={value} min={min} max={max} today={today} onSelect={onChange} onClose={() => setOpen(false)} />
    </>
  );
}

/** One date that may not be chosen yet ("Choose a date"), picked from the full-screen calendar. */
export function OptionalDatePickerField({
  label,
  value,
  min,
  max,
  onChange,
  today,
  appearance,
}: {
  /** `card` is the big search-form field card ("28 Nov" over "Saturday, 2026"). */
  appearance?: 'tile' | 'field' | 'card';
  label: string;
  value: ISODate | null;
  min: ISODate;
  max: ISODate;
  onChange: (date: ISODate) => void;
  today?: ISODate;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {appearance === 'card' ? (
        <FieldCard
          label={label}
          value={value ? dayMonth(value) : undefined}
          sub={value ? weekdayYear(value) : undefined}
          placeholder="Select"
          accessibilityLabel={`${label}: ${value ? formatShortDate(value) : 'Choose a date'}`}
          onPress={() => setOpen(true)}
        />
      ) : (
        <FieldButton
          label={label}
          value={value ? formatShortDate(value) : undefined}
          placeholder="Choose a date"
          icon="calendar-outline"
          chevron={false}
          appearance={appearance}
          onPress={() => setOpen(true)}
        />
      )}
      <CalendarScreen mode="single" visible={open} title={label} value={value} min={min} max={max} today={today} onSelect={onChange} onClose={() => setOpen(false)} />
    </>
  );
}

export function Stepper({
  label,
  value,
  min,
  max,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  hint?: string;
}) {
  return (
    <View style={styles.stepper}>
      <View style={styles.stepperText}>
        <Text variant="bodyStrong">{label}</Text>
        {hint ? (
          <Text variant="small" color="muted">
            {hint}
          </Text>
        ) : null}
      </View>
      <View style={styles.stepperControls}>
        <Pressable
          onPress={() => onChange(value - 1)}
          disabled={value <= min}
          accessibilityRole="button"
          accessibilityLabel={`Fewer ${label.toLowerCase()}`}
          accessibilityState={{ disabled: value <= min }}
          style={[styles.stepButton, value <= min && styles.stepOff]}
        >
          <Ionicons name="remove" size={20} color={colors.link} />
        </Pressable>
        <Text variant="h3" color="ink" style={styles.stepValue} accessibilityLiveRegion="polite">
          {value}
        </Text>
        <Pressable
          onPress={() => onChange(value + 1)}
          disabled={value >= max}
          accessibilityRole="button"
          accessibilityLabel={`More ${label.toLowerCase()}`}
          accessibilityState={{ disabled: value >= max }}
          style={[styles.stepButton, value >= max && styles.stepOff]}
        >
          <Ionicons name="add" size={20} color={colors.link} />
        </Pressable>
      </View>
    </View>
  );
}

/** Rooms, adults and children, within the limits the booking call will accept. */
export function GuestsField({ value, onChange, appearance = 'tile' }: { value: Party; onChange: (party: Party) => void; appearance?: 'tile' | 'card' }) {
  const [open, setOpen] = useState(false);
  const update = (patch: Partial<Party>) => onChange(normaliseParty({ ...value, ...patch }));
  const rooms = `${value.rooms} Room${value.rooms === 1 ? '' : 's'}`;
  const guests = [`${value.adults} Adult${value.adults === 1 ? '' : 's'}`, value.children ? `${value.children} Child${value.children === 1 ? '' : 'ren'}` : null].filter(Boolean).join(', ');
  return (
    <>
      {appearance === 'card' ? (
        <FieldCard label="Rooms & Guests" value={rooms} sub={guests} accessibilityLabel={`Guests and rooms: ${partySummary(value)}`} onPress={() => setOpen(true)} />
      ) : (
        <FieldButton label="Guests and rooms" value={partySummary(value)} icon="people-outline" onPress={() => setOpen(true)} />
      )}
      <BottomSheet visible={open} title="Rooms & Guests" onClose={() => setOpen(false)} footer={<Button title="Done" onPress={() => setOpen(false)} caps />}>
        <Stepper label="Rooms" value={value.rooms} min={PARTY_LIMITS.rooms.min} max={PARTY_LIMITS.rooms.max} hint="Up to 4" onChange={(rooms) => update({ rooms })} />
        <Stepper
          label="Adults"
          value={value.adults}
          min={Math.max(PARTY_LIMITS.adults.min, value.rooms)}
          max={PARTY_LIMITS.adults.max}
          hint="12 years and over · at least one per room"
          onChange={(adults) => update({ adults })}
        />
        <Stepper label="Children" value={value.children} min={PARTY_LIMITS.children.min} max={PARTY_LIMITS.children.max} hint="Under 12 years" onChange={(children) => update({ children })} />
      </BottomSheet>
    </>
  );
}

/**
 * Fields side by side when there is room, one per line when there is not. Each
 * keeps a 150-wide minimum, so two fit on a tablet or in landscape and stack on
 * a phone, with no breakpoint table and no truncated dates.
 */
export function FieldRow({ children }: { children: ReactNode }) {
  return (
    <View style={styles.fieldRow}>
      {Children.map(children, (child, i) => (
        <View key={i} style={styles.fieldCell}>
          {child}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  formField: { gap: 6 },
  formLabel: { fontFamily: fontFamily.sansSemiBold, fontSize: 11, lineHeight: 14, letterSpacing: 0.8, textTransform: 'uppercase', color: colors.textSecondary },
  formBox: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
    paddingHorizontal: 14,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
  },
  formValue: { flex: 1, fontSize: 15 },
  box: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
  },
  pressed: { backgroundColor: colors.bg },
  tileText: { flex: 1, minWidth: 0, gap: 1 },
  tileLabel: { fontFamily: fontFamily.sansSemiBold, fontSize: 11, lineHeight: 14, letterSpacing: 0.8, color: colors.textSecondary },
  tileSub: { fontSize: 12, lineHeight: 16 },
  value: { fontFamily: fontFamily.sansBold, fontSize: 16, lineHeight: 22 },
  fieldRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s3 },
  fieldCell: { flexGrow: 1, flexBasis: 150 },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 64, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider },
  stepperText: { flex: 1, gap: 2 },
  stepperControls: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3 },
  stepButton: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.link,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  stepOff: { borderColor: colors.line, opacity: 0.45 },
  stepValue: { minWidth: 28, textAlign: 'center' },
});
