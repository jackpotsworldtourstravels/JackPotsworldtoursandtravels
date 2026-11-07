import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Logo, Text } from '@/components';
import { CONTENT_MAX_WIDTH } from '@/components/Screen';
import { colors, fontFamily, gradients, shadow, spacing } from '@/theme';

/**
 * The shared frame of the sign-in, sign-up and verify screens, drawn as the website's account pages are (`register.html`):
 * a deep navy ground and one white card with a gold bar across its top, a centred bold title and a muted line under it,
 * and the fields below in tracked capitals. The top of the screen keeps the logo and a close button.
 */
export function AuthFrame({ children }: { children: ReactNode }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.root}>
      <LinearGradient colors={['#0A1120', '#16263F', '#0F1B2E']} start={{ x: 0.2, y: 0 }} end={{ x: 0.8, y: 1 }} style={StyleSheet.absoluteFill} />
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          contentContainerStyle={[
            styles.scroll,
            {
              paddingTop: insets.top + spacing.s2,
              paddingBottom: insets.bottom + spacing.s6,
              paddingLeft: spacing.s4 + insets.left,
              paddingRight: spacing.s4 + insets.right,
            },
          ]}
        >
          <View style={styles.top}>
            <Logo size={52} />
            <Pressable
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={12}
              style={styles.close}
            >
              <Ionicons name="close" size={26} color={colors.white} />
            </Pressable>
          </View>
          <View style={[styles.card, shadow.md]}>
            <LinearGradient colors={gradients.gold} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.bar} />
            <View style={styles.body}>{children}</View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

/** The card's title: bold, centred (`.auth h2`). */
export function AuthTitle({ children }: { children: string }) {
  return (
    <Text variant="h1" color="navy900" accessibilityRole="header" align="center" style={styles.title}>
      {children}
    </Text>
  );
}

/** The muted line under the title. */
export function AuthLede({ children }: { children: ReactNode }) {
  return (
    <Text variant="body" color="muted" align="center" style={styles.lede}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.navy900 },
  fill: { flex: 1 },
  scroll: { flexGrow: 1, gap: spacing.s4 },
  top: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  close: { minWidth: 44, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' },
  card: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center', backgroundColor: colors.white, borderRadius: 20, overflow: 'hidden' },
  bar: { height: 4 },
  body: { padding: 24, gap: spacing.s4 },
  title: { fontFamily: fontFamily.sansBold, fontSize: 25, lineHeight: 32, letterSpacing: -0.2 },
  lede: { fontSize: 14.5, lineHeight: 22 },
});
