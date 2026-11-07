import type { TextStyle } from 'react-native';

/**
 * Font family names as registered by `useFonts` in src/theme/fonts.ts.
 * React Native selects a weight by family name, not by `fontWeight`, so every
 * weight the site uses is its own entry.
 *
 * The site's UI face is Montserrat; Playfair Display is the editorial display
 * face for hero lines and section titles, with an italic accent.
 */
export const fontFamily = {
  sans: 'Montserrat_400Regular',
  sansMedium: 'Montserrat_500Medium',
  sansSemiBold: 'Montserrat_600SemiBold',
  sansBold: 'Montserrat_700Bold',
  display: 'PlayfairDisplay_500Medium',
  displayItalic: 'PlayfairDisplay_500Medium_Italic',
  displayBold: 'PlayfairDisplay_700Bold',
} as const;

export type TextVariant =
  | 'display'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'title'
  | 'body'
  | 'bodyStrong'
  | 'small'
  | 'caption'
  | 'eyebrow'
  | 'button';

/** Sizes follow `--ds-fs-*` (clamped values pinned to a phone-sized midpoint). */
export const textVariants: Record<TextVariant, TextStyle> = {
  display: { fontFamily: fontFamily.display, fontSize: 40, lineHeight: 44, letterSpacing: -0.8 },
  h1: { fontFamily: fontFamily.display, fontSize: 32, lineHeight: 36, letterSpacing: -0.6 },
  h2: { fontFamily: fontFamily.display, fontSize: 26, lineHeight: 31, letterSpacing: -0.4 },
  h3: { fontFamily: fontFamily.display, fontSize: 21, lineHeight: 26, letterSpacing: -0.2 },
  title: { fontFamily: fontFamily.sansBold, fontSize: 17, lineHeight: 24 },
  body: { fontFamily: fontFamily.sans, fontSize: 15, lineHeight: 22 },
  bodyStrong: { fontFamily: fontFamily.sansSemiBold, fontSize: 15, lineHeight: 22 },
  small: { fontFamily: fontFamily.sans, fontSize: 13.5, lineHeight: 19 },
  caption: { fontFamily: fontFamily.sansMedium, fontSize: 12, lineHeight: 16 },
  eyebrow: {
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 2.4,
    textTransform: 'uppercase',
  },
  button: { fontFamily: fontFamily.sansBold, fontSize: 16, lineHeight: 20 },
};
