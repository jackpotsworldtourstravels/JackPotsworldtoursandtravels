import { StyleSheet, View } from 'react-native';

import { isApiError } from '@/api/errors';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { useAuthDetour } from '@/features/auth/useReturnTo';
import { useAuth } from '@/providers/AuthProvider';
import { spacing } from '@/theme';

import { useWishlistToggle } from '../hooks';

/**
 * "Save to wishlist" on a hotel or package page.
 *
 * Whether it reads Saved comes from the server's own list, not from the last tap.
 * Signed out, a tap asks the visitor to sign in (or continue as a guest, whose
 * wishlist is kept and carried onto an account later) and brings them back here;
 * it does not save anything on their behalf afterwards.
 */
export function WishlistButton({ type, id }: { type: 'hotel' | 'package'; id: number }) {
  const { hasSession } = useAuth();
  const detour = useAuthDetour();
  const wishlist = useWishlistToggle(type, id);

  return (
    <View style={styles.wrap}>
      <Button
        title={wishlist.saved ? 'Saved to wishlist' : 'Save to wishlist'}
        variant="outline"
        icon={wishlist.saved ? 'heart' : 'heart-outline'}
        loading={hasSession && wishlist.busy}
        onPress={() => (hasSession ? wishlist.toggle() : detour('/sign-in'))}
      />
      {wishlist.error ? (
        <Text variant="small" color="danger" accessibilityRole="alert">
          {isApiError(wishlist.error) ? wishlist.error.message : 'We couldn’t update your wishlist. Please try again.'}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.s2 },
});
