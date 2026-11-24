import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Logo, Text } from '@/components';
import { CONTENT_MAX_WIDTH } from '@/components/Screen';
import { useAuth } from '@/providers/AuthProvider';
import { colors, fontFamily, spacing } from '@/theme';

/**
 * The shared frame of the sign-in, sign-up and verify screens: the company logo large on the deep navy ground, and
 * the form on a white sheet with rounded top corners below it. Sign-in is the first screen the app shows to someone
 * with no session, so the close button appears only when there is somewhere to go back to (a guest who chose to sign
 * in from inside the app).
 *
 * `logo`: `large` on sign-in, `medium` on the longer sign-up form and the code screen.
 */
export function AuthFrame({ children, logo = 'large' }: { children: ReactNode; logo?: 'large' | 'medium' }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { hasSession } = useAuth();
  const large = logo === 'large';

  return (
    <View style={styles.root}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          contentContainerStyle={styles.scroll}
          bounces={false}
        >
          <View style={[styles.top, { paddingTop: insets.top + spacing.s3, minHeight: insets.top + (large ? 300 : 210) }]}>
            {hasSession ? (
              <Pressable
                onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={8}
                style={({ pressed }) => [styles.close, { top: insets.top + spacing.s3, left: spacing.s4 + insets.left }, pressed && styles.pressed]}
              >
                <Ionicons name="close" size={22} color={colors.white} />
              </Pressable>
            ) : null}
            <Logo size={large ? 220 : 150} />
          </View>
          <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.s6, paddingLeft: spacing.s6 + insets.left, paddingRight: spacing.s6 + insets.right }]}>
            <View style={styles.body}>{children}</View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

/** The sheet's title: large and bold. */
export function AuthTitle({ children }: { children: string }) {
  return (
    <Text variant="h1" color="ink" accessibilityRole="header" style={styles.title}>
      {children}
    </Text>
  );
}

/** The line under the title. */
export function AuthLede({ children }: { children: ReactNode }) {
  return (
    <Text variant="body" color="textSecondary" style={styles.lede}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.navy900 },
  fill: { flex: 1 },
  scroll: { flexGrow: 1 },
  top: { alignItems: 'center', justifyContent: 'center', paddingBottom: spacing.s5 },
  close: {
    position: 'absolute',
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.navy700,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  pressed: { opacity: 0.7 },
  sheet: { flexGrow: 1, backgroundColor: colors.white, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingTop: spacing.s7 },
  body: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center', gap: spacing.s4 },
  title: { fontFamily: fontFamily.sansExtraBold, fontSize: 26, lineHeight: 32, letterSpacing: -0.3 },
  lede: { fontSize: 14, lineHeight: 21, marginTop: -spacing.s2 },
});
