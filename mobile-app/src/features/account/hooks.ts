import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { cancellationApi, profileApi, supportApi, travellerApi, wishlistApi } from '@/api/endpoints/account';
import { useOnce } from '@/hooks/useOnce';
import { useAuth } from '@/providers/AuthProvider';
import type {
  CancellationRequestInput,
  ProfileUpdate,
  SavedTraveller,
  TravellerInput,
  WishlistItem,
} from '@/types/account';

import { findSaved } from './wishlist';

const MINUTE = 60_000;

export const accountKeys = {
  all: ['account'] as const,
  wishlist: () => [...accountKeys.all, 'wishlist'] as const,
  travellers: () => [...accountKeys.all, 'travellers'] as const,
  sessions: () => [...accountKeys.all, 'sessions'] as const,
  tickets: () => [...accountKeys.all, 'tickets'] as const,
  ticket: (id: number) => [...accountKeys.all, 'ticket', id] as const,
};

/** Everything below is the signed-in customer's own, and is only asked for once there is a session. */

export function useWishlist() {
  const { hasSession } = useAuth();
  return useQuery({
    queryKey: accountKeys.wishlist(),
    enabled: hasSession,
    staleTime: MINUTE / 2,
    queryFn: wishlistApi.list,
  });
}

/**
 * The heart on a hotel or package page. `saved` comes from the server's list, so
 * it is true only for something the server has; a tap asks the server and the
 * heart follows the answer. Saving what is already saved is harmless on the
 * server, and the control is busy while a request or the refresh after it runs.
 */
export function useWishlistToggle(type: 'hotel' | 'package', id: number | null) {
  const queryClient = useQueryClient();
  const wishlist = useWishlist();
  const saved = id === null ? null : findSaved(wishlist.data, type, id);

  const mutation = useMutation({
    mutationFn: async () => {
      if (id === null) throw new Error('No item');
      if (saved) {
        await wishlistApi.remove(saved.id);
        return { removed: saved.id } as const;
      }
      return { added: await wishlistApi.add(type, id) } as const;
    },
    onSuccess: async (result) => {
      queryClient.setQueryData<WishlistItem[]>(accountKeys.wishlist(), (old = []) =>
        'removed' in result
          ? old.filter((i) => i.id !== result.removed)
          : old.some((i) => i.id === result.added.id)
            ? old
            : [result.added, ...old],
      );
      await queryClient.invalidateQueries({ queryKey: accountKeys.wishlist() });
    },
  });

  const toggle = useOnce(mutation.mutateAsync);

  return {
    saved: saved !== null,
    ready: wishlist.isSuccess,
    busy: mutation.isPending || wishlist.isFetching,
    error: mutation.error,
    toggle: () => toggle(),
  };
}

export function useRemoveWishlistItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => wishlistApi.remove(id),
    onSuccess: (_data, id) => {
      queryClient.setQueryData<WishlistItem[]>(accountKeys.wishlist(), (old = []) => old.filter((i) => i.id !== id));
      void queryClient.invalidateQueries({ queryKey: accountKeys.wishlist() });
    },
  });
}

export function useTravellers() {
  const { hasSession } = useAuth();
  return useQuery({
    queryKey: accountKeys.travellers(),
    enabled: hasSession,
    staleTime: MINUTE,
    queryFn: travellerApi.list,
  });
}

/** Create (no id) or update (id) a saved traveller. The server merges a repeated passport number rather than duplicating it. */
export function useSaveTraveller() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number | null; input: TravellerInput }): Promise<SavedTraveller> =>
      id === null ? travellerApi.create(input) : travellerApi.update(id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accountKeys.travellers() }),
  });
}

export function useDeleteTraveller() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => travellerApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accountKeys.travellers() }),
  });
}

export function useSessions() {
  const { hasSession } = useAuth();
  return useQuery({
    queryKey: accountKeys.sessions(),
    enabled: hasSession,
    staleTime: 0,
    queryFn: profileApi.sessions,
  });
}

/** Save profile changes and put the server's answer into the signed-in customer, so every screen shows it. */
export function useUpdateProfile() {
  const { setCustomer } = useAuth();
  return useMutation({
    mutationFn: (changes: ProfileUpdate) => profileApi.update(changes),
    onSuccess: (customer) => setCustomer(customer),
  });
}

export function useSupportTickets() {
  const { hasSession } = useAuth();
  return useQuery({
    queryKey: accountKeys.tickets(),
    enabled: hasSession,
    staleTime: 15_000,
    queryFn: supportApi.list,
  });
}

export function useSupportTicket(id: number | null) {
  const { hasSession } = useAuth();
  return useQuery({
    queryKey: accountKeys.ticket(id ?? 0),
    enabled: hasSession && id !== null,
    staleTime: 0,
    queryFn: () => supportApi.get(id as number),
  });
}

/** A cancellation REQUEST: the desk reviews it; nothing is cancelled and no money moves. */
export function useRequestCancellation() {
  return useMutation({ mutationFn: (input: CancellationRequestInput) => cancellationApi.request(input) });
}

