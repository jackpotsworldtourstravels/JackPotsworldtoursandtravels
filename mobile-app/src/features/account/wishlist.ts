import type { WishlistItem, WishlistItemType } from '@/types/account';

/** The kinds of saved item the app can show. Flights and cruises saved on the website have nothing to open here. */
export type SupportedWishlistType = 'hotel' | 'package';

export function isSupportedWishlistItem(item: WishlistItem): item is WishlistItem & { item_type: SupportedWishlistType } {
  return item.item_type === 'hotel' || item.item_type === 'package';
}

export function splitWishlist(items: readonly WishlistItem[]) {
  const shown = items.filter(isSupportedWishlistItem);
  return { shown, hiddenCount: items.length - shown.length };
}

export function findSaved(items: readonly WishlistItem[] | undefined, type: WishlistItemType, id: number): WishlistItem | null {
  return items?.find((i) => i.item_type === type && i.item_id === id) ?? null;
}
