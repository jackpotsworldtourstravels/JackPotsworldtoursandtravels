import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radius, shadow, spacing } from '@/theme';

import { Screen, type ScreenProps } from './Screen';
import { Text } from './Text';

/**
 * A form page (Help and support, a new request): the app header with a back arrow and the page title, an optional
 * one-line intro, then the page's cards. No breadcrumb hero and no website footer.
 */
export interface PageShellProps extends Pick<ScreenProps, 'keyboard' | 'refreshControl' | 'footer'> {
  /** The page title, shown in the header. */
  title: string;
  /** Kept for callers; the app header has no breadcrumb. */
  crumb?: string;
  lede?: string;
  /** Anything that belongs under the intro (a pill, a date ribbon). */
  heroExtra?: ReactNode;
  /** Kept for callers; content always starts under the header. */
  overlap?: boolean;
  children: ReactNode;
}

export function PageShell({ title, lede, heroExtra, keyboard, refreshControl, footer, children }: PageShellProps) {
  return (
    <Screen header={{ title, back: true }} scroll keyboard={keyboard} refreshControl={refreshControl} footer={footer}>
      {lede ? (
        <Text variant="body" color="textSecondary">
          {lede}
        </Text>
      ) : null}
      {heroExtra}
      {children}
    </Screen>
  );
}

/** The white card a page's form or results sit in. */
export function FormCard({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

/** A titled group of fields inside a FormCard. Sections in one card are divided by a hairline. */
export function FormSection({ title, sub, children, first = false }: { title: string; sub?: string; children: ReactNode; first?: boolean }) {
  return (
    <View style={[styles.section, !first && styles.sectionDivider]}>
      <View style={styles.sectionHead}>
        <Text variant="h3" color="ink" accessibilityRole="header">
          {title}
        </Text>
        {sub ? (
          <Text variant="small" color="textSecondary">
            {sub}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.s4, gap: spacing.s4, ...shadow.sm },
  section: { gap: spacing.s3 },
  sectionDivider: { paddingTop: spacing.s4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  sectionHead: { gap: 2 },
});
