import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Modal, Pressable, SectionList, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fontFamily, radius, spacing } from '@/theme';

import { Text } from './Text';

export interface SearchListItem {
  key: string;
  title: string;
  subtitle?: string;
  /** A short code badge at the left ("HYD"). */
  code?: string;
  /** An icon at the left when there is no code. */
  icon?: keyof typeof Ionicons.glyphMap;
  /** Muted text at the right ("India", "5 hotels"). */
  trailing?: string;
  selected?: boolean;
  accessibilityLabel?: string;
  onPress: () => void;
}

export interface SearchListSection {
  title: string;
  data: SearchListItem[];
}

/**
 * A full-screen picker: a close button and title, an autofocused search box, then sections of rows (recent,
 * popular, matches). Used for airports and destinations. The Android back button closes it.
 */
export function SearchListScreen({
  visible,
  title,
  query,
  onQueryChange,
  placeholder,
  sections,
  onClose,
  empty,
  header,
}: {
  visible: boolean;
  title: string;
  query: string;
  onQueryChange: (q: string) => void;
  placeholder: string;
  sections: SearchListSection[];
  onClose: () => void;
  /** Shown when every section is empty. */
  empty?: ReactNode;
  /** Anything above the list (a loading or error state). Replaces the list when given. */
  header?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const shown = sections.filter((s) => s.data.length > 0);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent presentationStyle="fullScreen">
      <View style={[styles.root, { paddingTop: insets.top }]} accessibilityViewIsModal>
        <View style={[styles.top, { paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right }]}>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={8} style={({ pressed }) => [styles.close, pressed && styles.dim]}>
            <Ionicons name="close" size={26} color={colors.ink} />
          </Pressable>
          <Text variant="h2" color="ink" accessibilityRole="header" style={styles.flex} numberOfLines={1}>
            {title}
          </Text>
        </View>
        <View style={[styles.searchWrap, { paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right }]}>
          <View style={styles.search}>
            <Ionicons name="search" size={20} color={colors.textSecondary} />
            <TextInput
              value={query}
              onChangeText={onQueryChange}
              placeholder={placeholder}
              placeholderTextColor={colors.textDisabled}
              autoFocus
              autoCorrect={false}
              autoCapitalize="words"
              returnKeyType="search"
              accessibilityLabel={placeholder}
              style={styles.input}
            />
            {query ? (
              <Pressable onPress={() => onQueryChange('')} accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={8}>
                <Ionicons name="close-circle" size={20} color={colors.textDisabled} />
              </Pressable>
            ) : null}
          </View>
        </View>
        {header ?? (
          <SectionList
            sections={shown}
            keyExtractor={(item) => item.key}
            keyboardShouldPersistTaps="handled"
            stickySectionHeadersEnabled={false}
            contentContainerStyle={{ paddingBottom: insets.bottom + spacing.s6 }}
            ListEmptyComponent={<View style={styles.empty}>{empty}</View>}
            renderSectionHeader={({ section }) => (
              <Text variant="label" color="textSecondary" style={styles.sectionTitle}>
                {section.title}
              </Text>
            )}
            renderItem={({ item }) => (
              <Pressable
                onPress={item.onPress}
                accessibilityRole="button"
                accessibilityLabel={item.accessibilityLabel ?? (item.subtitle ? `${item.title}, ${item.subtitle}` : item.title)}
                accessibilityState={{ selected: item.selected }}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              >
                {item.code ? (
                  <View style={styles.code}>
                    <Text variant="bodyStrong" color="navy900" chrome style={styles.codeText}>
                      {item.code}
                    </Text>
                  </View>
                ) : (
                  <View style={styles.code}>
                    <Ionicons name={item.icon ?? 'location-outline'} size={19} color={colors.link} />
                  </View>
                )}
                <View style={styles.flex}>
                  <Text variant="bodyStrong" color="ink" numberOfLines={1}>
                    {item.title}
                  </Text>
                  {item.subtitle ? (
                    <Text variant="small" color="textSecondary" numberOfLines={1}>
                      {item.subtitle}
                    </Text>
                  ) : null}
                </View>
                {item.trailing ? (
                  <Text variant="small" color="textSecondary" chrome>
                    {item.trailing}
                  </Text>
                ) : null}
                {item.selected ? <Ionicons name="checkmark-circle" size={20} color={colors.success} /> : null}
              </Pressable>
            )}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  flex: { flex: 1, minWidth: 0 },
  dim: { opacity: 0.6 },
  top: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2, minHeight: 52 },
  close: { width: 40, height: 44, justifyContent: 'center', marginLeft: -spacing.s1 },
  searchWrap: { paddingBottom: spacing.s3 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s2,
    height: 50,
    paddingHorizontal: spacing.s3,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.navy900,
    backgroundColor: colors.surface,
  },
  input: { flex: 1, fontFamily: fontFamily.sansMedium, fontSize: 15, color: colors.ink, paddingVertical: 0 },
  sectionTitle: { paddingHorizontal: spacing.s4, paddingTop: spacing.s4, paddingBottom: spacing.s2, backgroundColor: colors.bg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
    minHeight: 60,
    paddingHorizontal: spacing.s4,
    paddingVertical: spacing.s2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  rowPressed: { backgroundColor: colors.bg },
  code: { width: 46, height: 34, borderRadius: radius.sm, backgroundColor: colors.sand, alignItems: 'center', justifyContent: 'center' },
  codeText: { fontFamily: fontFamily.sansExtraBold, fontSize: 13 },
  empty: { padding: spacing.s6 },
});
