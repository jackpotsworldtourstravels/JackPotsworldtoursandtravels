import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { discoveryApi } from '@/api/endpoints/discovery';
import type { CouponProduct, PackageQuery } from '@/types/discovery';

const MINUTE = 60_000;

export const discoveryKeys = {
  all: ['discovery'] as const,
  destinations: () => [...discoveryKeys.all, 'destinations'] as const,
  locations: (id: string) => [...discoveryKeys.all, 'locations', id] as const,
  attractions: (id: string) => [...discoveryKeys.all, 'attractions', id] as const,
  destinationHotels: (id: string, page: number, locationId?: string) =>
    [...discoveryKeys.all, 'destination-hotels', id, locationId ?? null, page] as const,
  hotels: () => [...discoveryKeys.all, 'hotels'] as const,
  packages: (query: PackageQuery) => [...discoveryKeys.all, 'packages', query] as const,
  coupons: (product: CouponProduct) => [...discoveryKeys.all, 'coupons', product] as const,
};

/** The catalogue changes through the admin console, not minute to minute. */
export function useDestinations() {
  return useQuery({
    queryKey: discoveryKeys.destinations(),
    queryFn: discoveryApi.destinations,
    staleTime: 10 * MINUTE,
  });
}

export function useDestinationLocations(id: string | undefined) {
  return useQuery({
    queryKey: discoveryKeys.locations(id ?? ''),
    queryFn: () => discoveryApi.locations(id as string),
    enabled: Boolean(id),
    staleTime: 10 * MINUTE,
  });
}

export function useDestinationAttractions(id: string | undefined) {
  return useQuery({
    queryKey: discoveryKeys.attractions(id ?? ''),
    queryFn: () => discoveryApi.attractions(id as string),
    enabled: Boolean(id),
    staleTime: 10 * MINUTE,
  });
}

export function useDestinationHotels(id: string | undefined, options: { locationId?: string; page?: number } = {}) {
  const page = options.page ?? 1;
  return useQuery({
    queryKey: discoveryKeys.destinationHotels(id ?? '', page, options.locationId),
    queryFn: () => discoveryApi.destinationHotels(id as string, { page, locationId: options.locationId }),
    enabled: Boolean(id),
    staleTime: 5 * MINUTE,
    placeholderData: keepPreviousData,
  });
}

/**
 * A destination's hotels, page after page, for the results list. The server pages
 * (24 a time); this follows `total` so a destination that grows past one page
 * never silently truncates.
 */
export function useDestinationHotelsInfinite(id: string | undefined, options: { locationId?: string } = {}) {
  return useInfiniteQuery({
    queryKey: [...discoveryKeys.all, 'destination-hotels-infinite', id ?? '', options.locationId ?? null],
    queryFn: ({ pageParam }) =>
      discoveryApi.destinationHotels(id as string, { page: pageParam, locationId: options.locationId }),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.hotels.length, 0);
      return loaded < last.total && last.hotels.length > 0 ? last.page + 1 : undefined;
    },
    enabled: Boolean(id),
    staleTime: 5 * MINUTE,
  });
}

export function useHotels(enabled = true) {
  return useQuery({
    queryKey: discoveryKeys.hotels(),
    queryFn: discoveryApi.hotels,
    enabled,
    staleTime: 5 * MINUTE,
  });
}

export function usePackages(query: PackageQuery = {}) {
  return useQuery({
    queryKey: discoveryKeys.packages(query),
    queryFn: () => discoveryApi.packages(query),
    staleTime: 5 * MINUTE,
    placeholderData: keepPreviousData,
  });
}

export function useCoupons(product: CouponProduct) {
  return useQuery({
    queryKey: discoveryKeys.coupons(product),
    queryFn: () => discoveryApi.coupons(product),
    staleTime: 10 * MINUTE,
  });
}
