import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';

import { colors, maxChromeFontScale, textVariants, type ColorToken, type TextVariant } from '@/theme';

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  color?: ColorToken;
  align?: TextStyle['textAlign'];
  /**
   * Dense UI chrome (badges, pills, tab-like labels) caps how far the user's
   * font-size setting can grow it, so a layout can't break. Body copy is left
   * to scale, because people who need large text must get it.
   */
  chrome?: boolean;
}

/** Large enough for accessibility sizes, small enough to keep layouts from collapsing. */
const BODY_FONT_SCALE_CAP = 2;

export function Text({
  variant = 'body',
  color = 'ink',
  align,
  chrome = false,
  style,
  maxFontSizeMultiplier,
  ...rest
}: TextProps) {
  return (
    <RNText
      {...rest}
      maxFontSizeMultiplier={
        maxFontSizeMultiplier ?? (chrome ? maxChromeFontScale : BODY_FONT_SCALE_CAP)
      }
      style={[textVariants[variant], { color: colors[color] }, align ? { textAlign: align } : null, style]}
    />
  );
}
