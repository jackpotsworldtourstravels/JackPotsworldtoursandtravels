import { Ionicons } from '@expo/vector-icons';
import { Children, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { PARTY_LIMITS, normaliseParty, partySummary, type Party } from '@/features/search/party';
import { colors, fontFamily, radius, spacing } from '@/theme';
import { formatShortDate, type ISODate } from '@/utils/dates';

import { BottomSheet } from './BottomSheet';
import { Button } from './Button';
import { Calendar } from './Calendar';
import { Text } from './Text';

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
        <Text variant="caption" color="navy800" style={styles.formLabel}>
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
          <Ionicons name={icon} size={18} color={colors.goldInk} />
          <Text variant="body" color={value ? 'navy800' : 'muted'} numberOfLines={1} style={styles.formValue}>
            {value ?? placeholder}
          </Text>
          {chevron ? <Ionicons name="chevron-down" size={14} color={colors.muted} /> : null}
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
      <Ionicons name={icon} size={18} color={colors.goldInk} />
      <View style={styles.tileText}>
        <Text variant="caption" color="muted" chrome numberOfLines={1} style={styles.tileLabel}>
          {label.toUpperCase()}
        </Text>
        <Text variant="bodyStrong" color={value ? 'ink' : 'muted'} numberOfLines={1} style={styles.value}>
          {value ?? placeholder}
        </Text>
        {sub ? (
          <Text variant="small" color="muted" numberOfLines={1} style={styles.tileSub}>
            {sub}
          </Text>
        ) : null}
      </View>
      {chevron ? <Ionicons name="chevron-down" size={14} color={colors.muted} /> : null}
    </Pressable>
  );
}

/** One date, picked from a calendar sheet. */
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
      <BottomSheet visible={open} title={label} onClose={() => setOpen(false)}>
        <Calendar
          value={value}
          min={min}
          max={max}
          today={today}
          onSelect={(date) => {
            onChange(date);
            setOpen(false);
          }}
        />
      </BottomSheet>
    </>
  );
}

/** One date that may not be chosen yet ("Choose a date"), picked from a calendar sheet. */
export function OptionalDatePickerField({
  label,
  value,
  min,
  max,
  onChange,
  today,
  appearance,
}: {
  appearance?: 'tile' | 'field';
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
      <FieldButton
        label={label}
        value={value ? formatShortDate(value) : undefined}
        placeholder="Choose a date"
        icon="calendar-outline"
        chevron={false}
        appearance={appearance}
        onPress={() => setOpen(true)}
      />
      <BottomSheet visible={open} title={label} onClose={() => setOpen(false)}>
        <Calendar
          value={value ?? min}
          min={min}
          max={max}
          today={today}
          onSelect={(date) => {
            onChange(date);
            setOpen(false);
          }}
        />
      </BottomSheet>
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
          <Ionicons name="remove" size={22} color={colors.navy800} />
        </Pressable>
        <Text variant="title" color="navy800" style={styles.stepValue} accessibilityLiveRegion="polite">
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
          <Ionicons name="add" size={22} color={colors.navy800} />
        </Pressable>
      </View>
    </View>
  );
}

/** Rooms, adults and children, within the limits the booking call will accept. */
export function GuestsField({ value, onChange }: { value: Party; onChange: (party: Party) => void }) {
  const [open, setOpen] = useState(false);
  const update = (patch: Partial<Party>) => onChange(normaliseParty({ ...value, ...patch }));
  return (
    <>
      <FieldButton label="Guests and rooms" value={partySummary(value)} icon="people-outline" onPress={() => setOpen(true)} />
      <BottomSheet visible={open} title="Guests and rooms" onClose={() => setOpen(false)}>
        <Stepper label="Rooms" value={value.rooms} min={PARTY_LIMITS.rooms.min} max={PARTY_LIMITS.rooms.max} onChange={(rooms) => update({ rooms })} />
        <Stepper
          label="Adults"
          value={value.adults}
          min={Math.max(PARTY_LIMITS.adults.min, value.rooms)}
          max={PARTY_LIMITS.adults.max}
          hint="At least one adult per room"
          onChange={(adults) => update({ adults })}
        />
        <Stepper label="Children" value={value.children} min={PARTY_LIMITS.children.min} max={PARTY_LIMITS.children.max} onChange={(children) => update({ children })} />
        <Button title="Done" onPress={() => setOpen(false)} />
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
  formField: { gap: 7 },
  formLabel: { fontFamily: fontFamily.sansBold, fontSize: 10.5, lineHeight: 16, letterSpacing: 1.26, textTransform: 'uppercase' },
  formBox: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
    paddingHorizontal: 15,
    backgroundColor: colors.white,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
  },
  formValue: { flex: 1, fontSize: 16 },
  box: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s2,
    paddingVertical: 11,
    paddingHorizontal: 10,
    backgroundColor: colors.fieldFill,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.fieldLine,
  },
  pressed: { backgroundColor: colors.sand },
  tileText: { flex: 1, minWidth: 0 },
  tileLabel: { fontSize: 10.5, lineHeight: 16, letterSpacing: 1.05, fontWeight: '600', color: colors.fieldLabel },
  tileSub: { fontSize: 12, lineHeight: 16 },
  value: { fontSize: 16, lineHeight: 22 },
  fieldRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s3 },
  fieldCell: { flexGrow: 1, flexBasis: 150 },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 56 },
  stepperText: { flex: 1, gap: 2 },
  stepperControls: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3 },
  stepButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.navy800,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
  },
  stepOff: { opacity: 0.3 },
  stepValue: { minWidth: 28, textAlign: 'center' },
});
