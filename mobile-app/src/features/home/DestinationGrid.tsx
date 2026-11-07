import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { Animated, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';

import { Text } from '@/components';
import { RemoteImage } from '@/components/RemoteImage';
import { destinationPhotoUrl } from '@/features/media/mediaUrl';
import { mapTo, Reveal, useElementTop, useScrollMotion, useScrub } from '@/features/motion/ScrollMotion';
import { colors, fontFamily, spacing } from '@/theme';
import type { Destination } from '@/types/discovery';

/** `FIRST_SHOWN` in `frontend/assets/js/home-destinations.js`: nine cards, then "View all N destinations". */
export const FIRST_SHOWN = 9;
const GAP = 14;

/**
 * THE WEBSITE'S DESTINATIONS GRID (`.cine-grid` in home-cinema.css, cards from `cardHtml()` in
 * home-destinations.js), at phone width: two columns, and every third card (1st, 4th, 7th...) is a full-width
 * 16:10 feature, the others are 4:3. Each card is the destination's own photograph with the site's scrim, a
 * running number at the top right, the name in the display face, the country in small gold capitals and, on a
 * feature card, "Explore" with an arrow. Corners are 22px. "View all N destinations" opens the rest.
 */
export function DestinationGrid({ destinations, onOpen }: { destinations: readonly Destination[]; onOpen: (d: Destination) => void }) {
  const [expanded, setExpanded] = useState(false);
  // Measured once laid out; until then the window less the page's side padding, so the cards are never withheld.
  const window = useWindowDimensions();
  const [measured, setMeasured] = useState(0);
  const width = measured || Math.max(0, window.width - spacing.s4 * 2);
  const shown = expanded ? destinations : destinations.slice(0, FIRST_SHOWN);
  const half = Math.floor((width - GAP) / 2);

  return (
    <View>
      <View style={styles.grid} onLayout={(e) => setMeasured(e.nativeEvent.layout.width)}>
        {width > 0
          ? shown.map((d, i) => {
              const feature = i % 3 === 0;
              return (
                // `cards()` in home-cinema.js: each card arrives from below and behind (y 50 on a phone, scale .94,
                // 1.3s ease-out), the cards of a row one after another.
                <Reveal
                  key={d.id}
                  y={50}
                  scale={0.94}
                  duration={1300}
                  delay={(i % 3) * 120}
                  startAt={0.9}
                  style={{
                    width: feature || (i % 3 === 1 && i === shown.length - 1) ? width : half,
                  }}
                >
                  {({ progress }) => (
                    <Card
                      destination={d}
                      index={i}
                      feature={feature}
                      // A small card with no partner on its row (the last one, when it would be alone) is stretched, as the site does.
                      width={feature || (i % 3 === 1 && i === shown.length - 1) ? width : half}
                      arrival={progress}
                      onPress={() => onOpen(d)}
                    />
                  )}
                </Reveal>
              );
            })
          : null}
      </View>
      {destinations.length > FIRST_SHOWN && !expanded ? (
        <Pressable onPress={() => setExpanded(true)} accessibilityRole="button" accessibilityLabel={`View all ${destinations.length} destinations`} style={styles.more}>
          <Text variant="bodyStrong" color="navy800" chrome style={styles.moreText}>
            {`VIEW ALL ${destinations.length} DESTINATIONS`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// The height is stated, not left to `aspectRatio`: Android lays a stretched row item with an aspect ratio out at height 0
// (every card measured {width: 328, height: 0} on the phone), so the whole grid drew nothing while keeping its place.
function Card({
  destination,
  index,
  feature,
  width,
  arrival,
  onPress,
}: {
  destination: Destination;
  index: number;
  feature: boolean;
  width: number;
  arrival: Animated.Value;
  onPress: () => void;
}) {
  const height = Math.round(width / (feature ? 16 / 10 : 4 / 3));
  const { attach, measured, onLayout } = useElementTop();
  // The photograph drifts inside its frame as the card crosses the screen (`yPercent` -7 to 7), the text a little the other way.
  const crossing = useScrub(measured, 1, 0, true);
  const drift = mapTo(crossing, [-0.07 * height, 0.07 * height]);
  const lift = mapTo(crossing, [10, -10]);
  const motion = useScrollMotion();
  // The photograph "develops": faint and a little large to solid and exact as the card arrives.
  const developed = arrival.interpolate({
    inputRange: [0, 1],
    outputRange: [0.2, 1],
  });
  const settle = arrival.interpolate({
    inputRange: [0, 1],
    outputRange: [1.08, 1],
  });
  const still = !motion || motion.reduceMotion;
  const label = destination.country ? `${destination.name}, ${destination.country}` : destination.name;
  return (
    <View ref={attach} onLayout={onLayout}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`Explore ${label}`}
        style={({ pressed }) => [styles.card, { width, height }, pressed && styles.pressed]}
      >
        <Animated.View
          style={[
            styles.photo,
            still
              ? null
              : {
                  opacity: developed,
                  transform: [{ translateY: drift }, { scale: settle }],
                },
          ]}
        >
          <RemoteImage
            uri={destinationPhotoUrl(destination.image ?? destination.id, feature ? 'hero' : 'card')}
            alt={`${destination.name}, a photograph of the destination`}
            placeholderLabel={destination.name}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
        {/* The site's scrim: dark at the foot for the name, a little dark at the top for the number. */}
        <LinearGradient
          colors={['rgba(5,8,15,0.86)', 'rgba(5,8,15,0.5)', 'rgba(5,8,15,0.06)', 'rgba(5,8,15,0)']}
          locations={[0, 0.26, 0.56, 0.7]}
          start={{ x: 0.5, y: 1 }}
          end={{ x: 0.5, y: 0 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <LinearGradient colors={['rgba(5,8,15,0.4)', 'rgba(5,8,15,0)']} locations={[0, 0.24]} style={StyleSheet.absoluteFill} pointerEvents="none" />
        <View style={styles.num} pointerEvents="none">
          <View style={styles.numRule} />
          <Text variant="body" color="white" style={styles.numText}>
            {String(index + 1).padStart(2, '0')}
          </Text>
        </View>
        <Animated.View style={[styles.body, feature && styles.bodyFeature, still ? null : { transform: [{ translateY: lift }] }]} pointerEvents="none">
          <Text variant="h3" color="white" numberOfLines={2} style={feature ? styles.nameFeature : styles.name}>
            {destination.name}
          </Text>
          {destination.country ? (
            <Text variant="caption" color="goldLight" chrome style={styles.meta}>
              {destination.country.toUpperCase()}
            </Text>
          ) : null}
          {feature ? (
            <View style={styles.go}>
              <Text variant="caption" color="white" chrome style={styles.goText}>
                EXPLORE
              </Text>
              <Ionicons name="arrow-forward" size={16} color={colors.white} />
            </View>
          ) : null}
        </Animated.View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
  card: {
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: colors.night,
    shadowColor: colors.night,
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.22,
    shadowRadius: 22,
    elevation: 4,
  },
  pressed: { opacity: 0.92 },
  // Taller than its frame (the site's `.jw-dest-art { inset: -9% 0 }`), so it can drift without showing an edge.
  photo: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '-8%',
    height: '116%',
  },
  num: {
    position: 'absolute',
    top: spacing.s4,
    right: spacing.s4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  numRule: { width: 26, height: 1, backgroundColor: 'rgba(255,255,255,0.5)' },
  numText: {
    fontFamily: fontFamily.displayItalic,
    fontSize: 17,
    lineHeight: 20,
    color: 'rgba(255,255,255,0.82)',
  },
  body: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.s4,
    paddingVertical: spacing.s4,
  },
  bodyFeature: { paddingHorizontal: 20, paddingVertical: 20 },
  name: { fontSize: 22, lineHeight: 23, letterSpacing: -0.3 },
  nameFeature: { fontSize: 30, lineHeight: 32, letterSpacing: -0.45 },
  meta: {
    marginTop: 8,
    fontSize: 10.5,
    lineHeight: 14,
    letterSpacing: 2.7,
    fontWeight: '600',
  },
  go: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 },
  goText: { fontSize: 11, letterSpacing: 2.2, fontWeight: '700' },
  more: {
    alignSelf: 'center',
    marginTop: spacing.s7,
    paddingVertical: 15,
    paddingHorizontal: 30,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(21,27,39,0.2)',
    minHeight: 48,
    justifyContent: 'center',
  },
  moreText: { fontSize: 12, letterSpacing: 2.2, fontWeight: '700' },
});
