import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, spacing } from '@/theme';

import { CONTENT_MAX_WIDTH } from './Screen';
import { Text } from './Text';

/**
 * A sheet that slides up over the screen: travellers, rooms and guests, sort, filters. Tapping the dimmed area,
 * the Android back button and the close button all dismiss it, and it tells screen readers it is modal so focus
 * stays inside. Tall content scrolls inside the sheet; `footer` stays pinned under it (Apply / Clear).
 */
export function BottomSheet({
  visible,
  title,
  onClose,
  children,
  footer,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root} accessibilityViewIsModal>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel={`Close ${title}`} />
        <View style={[styles.sheet, { paddingBottom: (footer ? spacing.s3 : spacing.s5) + insets.bottom }]}>
          <View style={styles.handle} />
          <View style={styles.titleRow}>
            <Text variant="h2" color="ink" accessibilityRole="header" style={styles.title}>
              {title}
            </Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={10} style={({ pressed }) => [styles.close, pressed && styles.dim]}>
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </Pressable>
          </View>
          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled" bounces={false}>
            {children}
          </ScrollView>
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(6,10,18,0.55)' },
  sheet: {
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    maxHeight: '88%',
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.s5,
    paddingTop: spacing.s3,
  },
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: colors.line, marginBottom: spacing.s3 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.s3, marginBottom: spacing.s2 },
  title: { flex: 1 },
  close: { minWidth: 44, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' },
  dim: { opacity: 0.6 },
  body: { flexGrow: 0 },
  bodyContent: { gap: spacing.s3, paddingBottom: spacing.s2 },
  footer: { paddingTop: spacing.s3, gap: spacing.s2 },
});
