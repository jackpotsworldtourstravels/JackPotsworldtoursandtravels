import { findSaved, isSupportedWishlistItem, splitWishlist } from '@/features/account/wishlist';

import { wishlistItem } from '../fixtures/account';

describe('what the app can show from a wishlist', () => {
  const items = [
    wishlistItem({ id: 1, item_type: 'hotel', item_id: 4 }),
    wishlistItem({ id: 2, item_type: 'package', item_id: 8 }),
    wishlistItem({ id: 3, item_type: 'flight', item_id: 99 }),
    wishlistItem({ id: 4, item_type: 'cruise', item_id: 5 }),
  ];

  it('shows hotels and packages, and counts what it cannot show rather than hiding it silently', () => {
    const { shown, hiddenCount } = splitWishlist(items);
    expect(shown.map((i) => i.id)).toEqual([1, 2]);
    expect(hiddenCount).toBe(2);
  });

  it('knows which item types it supports', () => {
    expect(items.map(isSupportedWishlistItem)).toEqual([true, true, false, false]);
  });

  it('is empty and has nothing hidden for no items', () => {
    expect(splitWishlist([])).toEqual({ shown: [], hiddenCount: 0 });
  });

  it('finds a saved item by type and id: hotel 4 is not package 4', () => {
    expect(findSaved(items, 'hotel', 4)?.id).toBe(1);
    expect(findSaved(items, 'package', 4)).toBeNull();
    expect(findSaved(undefined, 'hotel', 4)).toBeNull();
  });
});
