import type { TextStyle } from 'react-native';

/**
 * Font family names as registered by `useFonts` in src/theme/fonts.ts.
 * React Native selects a weight by family name, not by `fontWeight`, so every
 * weight is its own entry.
 *
 * UI OVERHAUL: the app uses ONE sans family, Montserrat (the brand's UI face). The website's Playfair Display
 * serif is gone from the app UI; the `display*` keys are kept so existing styles resolve, and now point at
 * Montserrat's heavy weights.
 */
export const fontFamily = {
  sans: 'Montserrat_400Regular',
  sansMedium: 'Montserrat_500Medium',
  sansSemiBold: 'Montserrat_600SemiBold',
  sansBold: 'Montserrat_700Bold',
  sansExtraBold: 'Montserrat_800ExtraBold',
  display: 'Montserrat_800ExtraBold',
  displayItalic: 'Montserrat_700Bold',
  displayBold: 'Montserrat_800ExtraBold',
} as const;

export type TextVariant =
  | 'hero'
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
  | 'label'
  | 'button';

/**
 * A dense, app-like scale:
 *   hero     28 ExtraBold  big values (airport code, headline price)
 *   display  24 ExtraBold  page-level headline (sign-in, confirmation)
 *   h1       20 Bold       large screen title (tab roots: "My Bookings")
 *   h2       18 Bold       screen title
 *   h3/title 16 Bold       section title, card title
 *   body     14 Regular    body copy
 *   small    13            secondary
 *   caption  12            meta
 *   label    11 SemiBold   field labels: FROM, TO, DEPARTURE
 */
export const textVariants: Record<TextVariant, TextStyle> = {
  hero: { fontFamily: fontFamily.sansExtraBold, fontSize: 28, lineHeight: 34 },
  display: { fontFamily: fontFamily.sansExtraBold, fontSize: 24, lineHeight: 30 },
  h1: { fontFamily: fontFamily.sansBold, fontSize: 20, lineHeight: 26 },
  h2: { fontFamily: fontFamily.sansBold, fontSize: 18, lineHeight: 24 },
  h3: { fontFamily: fontFamily.sansBold, fontSize: 16, lineHeight: 22 },
  title: { fontFamily: fontFamily.sansBold, fontSize: 16, lineHeight: 22 },
  body: { fontFamily: fontFamily.sans, fontSize: 14, lineHeight: 20 },
  bodyStrong: { fontFamily: fontFamily.sansSemiBold, fontSize: 14, lineHeight: 20 },
  small: { fontFamily: fontFamily.sans, fontSize: 13, lineHeight: 18 },
  caption: { fontFamily: fontFamily.sansMedium, fontSize: 12, lineHeight: 16 },
  eyebrow: {
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  label: {
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  button: { fontFamily: fontFamily.sansBold, fontSize: 15, lineHeight: 20 },
};
