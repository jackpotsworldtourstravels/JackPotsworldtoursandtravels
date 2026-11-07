import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { isApiError } from '@/api/errors';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { RemoteImage } from '@/components/RemoteImage';
import { Text } from '@/components/Text';
import { useHotelDetail, usePackageDetail } from '@/features/booking/hooks';
import { packageDuration, packagePlace } from '@/features/discovery/packages';
import { resolveHotelPhoto } from '@/features/media/hotelPhoto';
import { packagePhotoUrl } from '@/features/media/mediaUrl';
import { useOnce } from '@/hooks/useOnce';
import { spacing } from '@/theme';
import type { WishlistItem } from '@/types/account';

import { useRemoveWishlistItem } from '../hooks';

function RemoveButton({ item, label }: { item: WishlistItem; label: string }) {
  const remove = useRemoveWishlistItem();
  const removeOnce = useOnce(remove.mutateAsync);
  return (
    <View style={styles.remove}>
      <Button
        title="Remove"
        variant="ghost"
        icon="heart-dislike-outline"
        fullWidth={false}
        loading={remove.isPending}
        onPress={() => removeOnce(item.id)}
        accessibilityLabel={`Remove ${label} from wishlist`}
      />
      {remove.isError ? (
        <Text variant="small" color="danger" accessibilityRole="alert">
          {isApiError(remove.error) ? remove.error.message : 'We couldn’t remove that. Please try again.'}
        </Text>
      ) : null}
    </View>
  );
}

function Unavailable({ item, kind, missing }: { item: WishlistItem; kind: 'hotel' | 'tour package'; missing: boolean }) {
  return (
    <Card style={styles.card}>
      <Text variant="bodyStrong" color="navy800">
        {missing ? `This ${kind} is no longer listed` : `We couldn’t load this ${kind} right now`}
      </Text>
      <Text variant="small" color="muted">
        {missing ? 'You can remove it from your wishlist.' : 'Check your connection and pull down to refresh.'}
      </Text>
      <RemoveButton item={item} label={`this ${kind}`} />
    </Card>
  );
}

export function HotelWishlistRow({ item }: { item: WishlistItem }) {
  const router = useRouter();
  const detail = useHotelDetail(item.item_id);

  if (detail.isPending) {
    return (
      <Card style={styles.card}>
        <Text variant="small" color="muted">
          Loading…
        </Text>
      </Card>
    );
  }
  if (detail.isError) {
    return <Unavailable item={item} kind="hotel" missing={isApiError(detail.error) && detail.error.kind === 'not_found'} />;
  }
  const hotel = detail.data;
  // Same rule as everywhere: never another hotel's photo as this one.
  const photo = resolveHotelPhoto(
    { name: hotel.name, location: hotel.location, source: hotel.source, hotelbeds_code: hotel.hotelbeds_code, provider_images: hotel.provider_images },
    { size: 'card' },
  );
  return (
    <Card style={styles.card}>
      <Pressable
        onPress={() => router.push({ pathname: '/hotels/[id]', params: { id: String(item.item_id) } })}
        accessibilityRole="button"
        accessibilityLabel={`${hotel.name}, ${hotel.location}`}
        style={styles.open}
      >
        <RemoteImage
          uri={photo.uri}
          alt={photo.alt}
          aspectRatio={16 / 9}
          rounded
          caption={photo.kind === 'destination' ? photo.note : undefined}
          placeholderLabel={photo.kind === 'placeholder' ? photo.note : undefined}
        />
        <Text variant="caption" color="goldInk" chrome>
          HOTEL
        </Text>
        <Text variant="title" color="navy800">
          {hotel.name}
        </Text>
        <Text variant="small" color="muted">
          {hotel.location}
        </Text>
      </Pressable>
      <RemoveButton item={item} label={hotel.name} />
    </Card>
  );
}

export function PackageWishlistRow({ item }: { item: WishlistItem }) {
  const router = useRouter();
  const detail = usePackageDetail(item.item_id);

  if (detail.isPending) {
    return (
      <Card style={styles.card}>
        <Text variant="small" color="muted">
          Loading…
        </Text>
      </Card>
    );
  }
  if (detail.isError) {
    return <Unavailable item={item} kind="tour package" missing={isApiError(detail.error) && detail.error.kind === 'not_found'} />;
  }
  const pkg = detail.data;
  const place = packagePlace(pkg);
  return (
    <Card style={styles.card}>
      <Pressable
        onPress={() => router.push({ pathname: '/packages/[id]', params: { id: String(item.item_id) } })}
        accessibilityRole="button"
        accessibilityLabel={`${pkg.name}${place ? `, ${place}` : ''}`}
        style={styles.open}
      >
        <RemoteImage
          uri={packagePhotoUrl(pkg.image, 'card')}
          alt={`${pkg.name}, a photograph of ${pkg.destination ?? 'the destination'}`}
          aspectRatio={16 / 9}
          rounded
          placeholderLabel={pkg.destination ?? pkg.name}
        />
        <Text variant="caption" color="goldInk" chrome>
          TOUR PACKAGE
        </Text>
        <Text variant="title" color="navy800">
          {pkg.name}
        </Text>
        <Text variant="small" color="muted">
          {[place, packageDuration(pkg)].filter(Boolean).join(' · ')}
        </Text>
      </Pressable>
      <RemoveButton item={item} label={pkg.name} />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.s2 },
  open: { gap: spacing.s2 },
  remove: { gap: spacing.s1, alignItems: 'flex-start' },
});
