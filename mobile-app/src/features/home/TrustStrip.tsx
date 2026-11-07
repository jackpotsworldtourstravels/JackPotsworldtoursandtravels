import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/components';
import { colors, spacing } from '@/theme';

import { TRUST } from './copy';

/** The three reassurances the website prints under its search card (`booking-card.js` TRUST). */
export function TrustStrip() {
  return (
    <View style={styles.row}>
      {TRUST.map((t) => (
        <View key={t.title} style={styles.item} accessible accessibilityLabel={`${t.title}. ${t.sub}`}>
          <Ionicons name={t.icon} size={22} color={colors.goldInk} />
          <Text variant="caption" color="navy800" align="center" chrome style={styles.title}>
            {t.title}
          </Text>
          <Text variant="caption" color="muted" align="center" chrome>
            {t.sub}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing.s2, paddingHorizontal: spacing.s3, paddingTop: spacing.s3 },
  item: { flex: 1, alignItems: 'center', gap: 2 },
  title: { fontWeight: '700' },
});
