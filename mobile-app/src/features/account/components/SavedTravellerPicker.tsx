import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { colors, minTouchTarget, spacing } from '@/theme';
import type { SavedTraveller } from '@/types/account';

import { passportHint, travellerName } from '../travellerForm';

/**
 * "Use a saved traveller": fills one person's name (and passport, where the form
 * asks for it) from the customer's saved list. It only copies into the form; the
 * form's own rules, such as the six-months passport check, still apply.
 */
export function SavedTravellerPicker({ travellers, onPick }: { travellers: readonly SavedTraveller[]; onPick: (t: SavedTraveller) => void }) {
  const [open, setOpen] = useState(false);
  if (travellers.length === 0) return null;
  return (
    <View>
      <Button title="Use a saved traveller" variant="ghost" icon="people-outline" fullWidth={false} onPress={() => setOpen(true)} />
      <BottomSheet visible={open} title="Saved travellers" onClose={() => setOpen(false)}>
        <View style={styles.list}>
          {travellers.map((t) => {
            const hint = passportHint(t);
            return (
              <Pressable
                key={t.customer_traveller_id}
                onPress={() => {
                  onPick(t);
                  setOpen(false);
                }}
                accessibilityRole="button"
                accessibilityLabel={`${travellerName(t)}${hint ? `, ${hint}` : ''}`}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <Text variant="bodyStrong" color="navy800">
                  {travellerName(t)}
                </Text>
                <Text variant="small" color="muted">
                  {[t.traveller_type[0].toUpperCase() + t.traveller_type.slice(1), hint].filter(Boolean).join(' · ')}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 0 },
  row: {
    minHeight: minTouchTarget + 8,
    justifyContent: 'center',
    gap: 2,
    paddingVertical: spacing.s2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  pressed: { opacity: 0.85 },
});
