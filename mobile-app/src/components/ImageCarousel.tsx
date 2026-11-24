import { useState } from 'react';
import { FlatList, StyleSheet, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { colors, spacing } from '@/theme';

import { RemoteImage } from './RemoteImage';

export interface CarouselPhoto {
  uri: string | null;
  alt: string;
  /** "Destination photo, not this hotel" for a city photo standing in for a property. */
  caption?: string;
}

/**
 * Full-width photos that page sideways, with pager dots. One photo is shown on its own, without dots: the
 * carousel never pads itself out with photos that are not of the place.
 */
export function ImageCarousel({ photos, height }: { photos: CarouselPhoto[]; height: number }) {
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => setIndex(Math.round(e.nativeEvent.contentOffset.x / Math.max(1, width)));

  if (photos.length <= 1) {
    const p = photos[0];
    return <RemoteImage uri={p?.uri} alt={p?.alt ?? ''} caption={p?.caption} height={height} />;
  }
  return (
    <View style={{ height }}>
      <FlatList
        horizontal
        pagingEnabled
        data={photos}
        keyExtractor={(p, i) => `${p.uri ?? 'none'}-${i}`}
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScroll}
        renderItem={({ item }) => <RemoteImage uri={item.uri} alt={item.alt} caption={item.caption} height={height} style={{ width }} />}
      />
      <View style={styles.dots} pointerEvents="none">
        {photos.map((_, i) => (
          <View key={i} style={[styles.dot, i === index && styles.dotOn]} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dots: { position: 'absolute', bottom: spacing.s3, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.55)' },
  dotOn: { width: 18, backgroundColor: colors.white },
});
