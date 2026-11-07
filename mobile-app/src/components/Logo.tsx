import { Image } from 'expo-image';
import type { StyleProp } from 'react-native';
import type { ImageStyle } from 'expo-image';

/**
 * The company mark, copied from the website (frontend/assets/images/
 * jackpots-logo-full.png), proportions untouched. It is gold on transparent
 * with a white-outline "WORLD", so it belongs on the navy surfaces only.
 *
 * The file is 606x600. That is sharp up to about 200 logical pixels, which is
 * everything the app draws; the store icon needs a larger master (README).
 */
const source = require('../../assets/images/logo.png');

export function Logo({ size = 44, style }: { size?: number; style?: StyleProp<ImageStyle> }) {
  return (
    <Image
      source={source}
      contentFit="contain"
      accessibilityLabel="JackpotsWorld Tours & Travels"
      style={[{ width: size, height: size * (600 / 606) }, style]}
    />
  );
}
