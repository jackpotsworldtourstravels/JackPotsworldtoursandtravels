import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { isApiError } from '@/api/errors';
import { Button } from '@/components/Button';
import { PhotoAction } from '@/components/DetailScroll';
import { Text } from '@/components/Text';
import { Toast } from '@/components/Toast';
import { useAuthDetour } from '@/features/auth/useReturnTo';
import { useAuth } from '@/providers/AuthProvider';
import { spacing } from '@/theme';

import { useWishlistToggle } from '../hooks';

/**
 * "Save to wishlist" on a hotel or package page. `heart` is the round heart over the page's photo; `button` the
 * full-width outline button.
 *
 * Whether it reads Saved comes from the server's own list, not from the last tap.
 * Signed out, a tap asks the visitor to sign in (or continue as a guest, whose
 * wishlist is kept and carried onto an account later) and brings them back here;
 * it does not save anything on their behalf afterwards.
 */
export function WishlistButton({ type, id, appearance = 'button' }: { type: 'hotel' | 'package'; id: number; appearance?: 'button' | 'heart' }) {
  const { hasSession } = useAuth();
  const detour = useAuthDetour();
  const wishlist = useWishlistToggle(type, id);
  const [toast, setToast] = useState(false);
  const message = wishlist.error ? (isApiError(wishlist.error) ? wishlist.error.message : 'We couldn’t update your wishlist. Please try again.') : null;
  // Show the toast when a new error arrives, and hide it when the error clears (set during render, not in an effect).
  const [toastFor, setToastFor] = useState<string | null>(null);
  if (message !== toastFor) {
    setToastFor(message);
    setToast(message !== null);
  }

  const press = () => (hasSession ? wishlist.toggle() : detour('/sign-in'));
  const label = wishlist.saved ? 'Saved to wishlist' : 'Save to wishlist';

  if (appearance === 'heart') {
    return (
      <>
        <PhotoAction icon={wishlist.saved ? 'heart' : 'heart-outline'} label={label} active={wishlist.saved} onPress={press} />
        <Toast message={message ?? ''} visible={toast} tone="info" onHide={() => setToast(false)} />
      </>
    );
  }

  return (
    <View style={styles.wrap}>
      <Button title={label} variant="outline" icon={wishlist.saved ? 'heart' : 'heart-outline'} loading={hasSession && wishlist.busy} onPress={press} />
      {message ? (
        <Text variant="small" color="danger" accessibilityRole="alert">
          {message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.s2 },
});
