import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radius, spacing } from '@/theme';

import { Text } from './Text';

export interface RemoteImageProps {
  uri: string | null | undefined;
  /** Describes the picture to screen readers. Honest: a city photo says it is not the hotel. */
  alt: string;
  /** width / height */
  aspectRatio?: number;
  height?: DimensionValue;
  /** A caption laid over the bottom-left corner, e.g. "Destination photo, not this hotel". */
  caption?: string;
  /** Text inside the placeholder when there is no picture. */
  placeholderLabel?: string;
  rounded?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * A photograph with a calm fallback.
 *
 * Failure is expected, not exceptional: some attractions have no photograph on
 * the site, and a phone loses signal. Either way the card keeps its shape and
 * shows the navy brand panel instead of a broken-image icon.
 */
export function RemoteImage({
  uri,
  alt,
  aspectRatio,
  height,
  caption,
  placeholderLabel,
  rounded = false,
  style,
}: RemoteImageProps) {
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const failed = !uri || failedUri === uri;

  return (
    <View
      style={[styles.box, aspectRatio ? { aspectRatio } : null, height !== undefined ? { height } : null, rounded && styles.rounded, style]}
    >
      {failed ? (
        <View style={styles.placeholder} accessible accessibilityLabel={alt} accessibilityRole="image">
          <Ionicons name="image-outline" size={28} color={colors.onDark2} />
          {placeholderLabel ? (
            <Text variant="caption" color="onDark2" align="center" chrome>
              {placeholderLabel}
            </Text>
          ) : null}
        </View>
      ) : (
        <Image
          source={{ uri }}
          contentFit="cover"
          transition={200}
          cachePolicy="memory-disk"
          accessible
          accessibilityLabel={alt}
          accessibilityRole="image"
          onError={() => setFailedUri(uri)}
          style={StyleSheet.absoluteFill}
        />
      )}
      {caption ? (
        <View style={styles.caption} pointerEvents="none">
          <Text variant="caption" color="white" chrome numberOfLines={1}>
            {caption}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: colors.navy800, overflow: 'hidden' },
  rounded: { borderRadius: radius.lg },
  placeholder: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.s2,
    padding: spacing.s3,
    backgroundColor: colors.navy800,
  },
  caption: {
    position: 'absolute',
    left: spacing.s2,
    bottom: spacing.s2,
    right: spacing.s2,
    paddingHorizontal: spacing.s2,
    paddingVertical: 3,
    borderRadius: radius.sm,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(6,10,18,0.66)',
  },
});
