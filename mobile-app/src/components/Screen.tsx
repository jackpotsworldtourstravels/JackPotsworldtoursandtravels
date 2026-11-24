import { StatusBar } from 'expo-status-bar';
import type { ReactNode } from 'react';
import { Animated, KeyboardAvoidingView, Platform, RefreshControlProps, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScrollMotionProvider, useScrollMotionState } from '@/features/motion/ScrollMotion';
import { colors, spacing } from '@/theme';

import { BrandHeader, type BrandHeaderProps } from './BrandHeader';

export interface ScreenProps {
  children: ReactNode;
  /** The app header above the content (back arrow, title, subtitle, one action). */
  header?: boolean | BrandHeaderProps;
  /** Wrap in a ScrollView. Forms and long pages need it. */
  scroll?: boolean;
  /** Lift content above the keyboard. On for any screen with inputs. */
  keyboard?: boolean;
  /**
   * Apply the bottom safe-area inset. ON by default, so a pushed screen's last button or footer is never under the system
   * navigation bar; the tab screens turn it off because the tab bar already clears it.
   */
  bottomInset?: boolean;
  refreshControl?: React.ReactElement<RefreshControlProps>;
  contentStyle?: StyleProp<ViewStyle>;
  /**
   * Edge to edge: no side gutters, no top gap, no reading-column cap, no gap between
   * children. For a page that is a stack of full-width bands (Home's header band).
   * Each band pads itself; the side safe-area insets are then ITS job too.
   */
  flush?: boolean;
  /**
   * Run the page's scroll-driven motion (arrivals and scrubbed effects; see `features/motion/ScrollMotion`).
   * Off by default: every other screen is a plain ScrollView.
   */
  scrollMotion?: boolean;
  /**
   * A sticky bar under the content (`StickyFooter`, `SortFilterBar`): price and the primary action stay on screen
   * while the page scrolls. Those components clear the bottom safe area themselves.
   */
  footer?: ReactNode;
  /** Status bar content when there is no header: `light` over a navy band, `dark` over ivory. */
  statusBar?: 'light' | 'dark';
}

/** Content is held to a readable column on tablets and in landscape. */
export const CONTENT_MAX_WIDTH = 640;

/**
 * Every screen's frame: ivory page, safe areas, optional app header, keyboard avoidance, scrolling and an optional
 * sticky footer, so individual screens contain no inset math. The status bar follows the header: light content on
 * the navy band, dark on a light bar or a bare ivory screen.
 */
export function Screen({
  children,
  header = false,
  scroll = false,
  keyboard = false,
  bottomInset = true,
  refreshControl,
  contentStyle,
  flush = false,
  scrollMotion = false,
  footer,
  statusBar,
}: ScreenProps) {
  const insets = useSafeAreaInsets();
  const motion = useScrollMotionState();

  // With a footer, the footer owns the bottom inset.
  const bodyInset = bottomInset && !footer ? insets.bottom : 0;
  const padding = {
    paddingLeft: flush ? 0 : spacing.s4 + insets.left,
    paddingRight: flush ? 0 : spacing.s4 + insets.right,
    paddingBottom: flush ? bodyInset : spacing.s6 + bodyInset,
  };

  const column = (
    <View ref={scrollMotion ? motion.setContent : undefined} style={[styles.column, flush && styles.columnFlush, contentStyle]}>
      {children}
    </View>
  );
  const Scroller = scrollMotion ? Animated.ScrollView : ScrollView;
  const body = scroll ? (
    <Scroller
      {...(scrollMotion ? motion.scrollProps : null)}
      refreshControl={refreshControl}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={[styles.scrollContent, flush && styles.scrollContentFlush, padding]}
    >
      {scrollMotion ? <ScrollMotionProvider value={motion.value}>{column}</ScrollMotionProvider> : column}
    </Scroller>
  ) : (
    <View style={[styles.fill, padding]}>
      <View style={[styles.column, flush && styles.columnFlush, styles.fill, contentStyle]}>{children}</View>
    </View>
  );

  const headerProps: BrandHeaderProps = typeof header === 'object' ? header : {};
  const barStyle = header ? (headerProps.tone === 'light' ? 'dark' : 'light') : (statusBar ?? 'dark');

  const main = (
    <>
      {body}
      {/* The footer components (StickyFooter, SortFilterBar) clear the bottom safe area themselves. */}
      {footer ?? null}
    </>
  );

  return (
    <View style={styles.root}>
      <StatusBar style={barStyle} />
      {header ? <BrandHeader {...headerProps} /> : null}
      {keyboard ? (
        <KeyboardAvoidingView style={styles.fill} behavior="padding">
          {main}
        </KeyboardAvoidingView>
      ) : (
        main
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  fill: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingTop: spacing.s4 },
  scrollContentFlush: { paddingTop: 0 },
  column: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center', gap: spacing.s4 },
  // `undefined` would not reliably override the column's cap on every platform; 100% does.
  columnFlush: { maxWidth: '100%', alignSelf: 'stretch', gap: 0 },
});
