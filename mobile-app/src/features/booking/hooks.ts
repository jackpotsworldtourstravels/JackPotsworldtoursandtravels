import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { hotelApi, packageApi, paymentsApi } from '@/api/endpoints/booking';
import { stableStringify } from '@/features/booking/attempts';
import { useAuth } from '@/providers/AuthProvider';
import type {
  AnyBooking,
  HotelBooking,
  HotelQuoteRequest,
  PackageBooking,
  PackageQuoteRequest,
} from '@/types/booking';

import type { BookingKind } from './refs';

const MINUTE = 60_000;

export const bookingKeys = {
  all: ['booking'] as const,
  hotel: (id: number) => [...bookingKeys.all, 'hotel', id] as const,
  package: (id: number) => [...bookingKeys.all, 'package', id] as const,
  hotelQuote: (request: HotelQuoteRequest) => [...bookingKeys.all, 'hotel-quote', stableStringify(request)] as const,
  packageQuote: (request: PackageQuoteRequest) => [...bookingKeys.all, 'package-quote', stableStringify(request)] as const,
  payments: (ref?: string) => [...bookingKeys.all, 'payments-config', ref ?? null] as const,
  one: (kind: BookingKind, ref: string) => [...bookingKeys.all, 'one', kind, ref] as const,
  mine: () => [...bookingKeys.all, 'mine'] as const,
};

export function useHotelDetail(id: number | null) {
  return useQuery({
    queryKey: bookingKeys.hotel(id ?? 0),
    queryFn: () => hotelApi.detail(id as number),
    enabled: id !== null,
    staleTime: 5 * MINUTE,
  });
}

export function usePackageDetail(id: number | null) {
  return useQuery({
    queryKey: bookingKeys.package(id ?? 0),
    queryFn: () => packageApi.detail(id as number),
    enabled: id !== null,
    staleTime: 5 * MINUTE,
  });
}

/**
 * The server's price for these exact choices. Never cached for long: a quote is
 * only worth anything as fresh as the choices it was asked for, and the booking
 * is priced again when it is created. While a changed request is in flight the
 * previous answer is kept on screen, but `isPlaceholderData` is true, and the
 * screen must not let anyone book against it.
 */
export function useHotelQuote(request: HotelQuoteRequest | null) {
  return useQuery({
    queryKey: request ? bookingKeys.hotelQuote(request) : bookingKeys.all,
    queryFn: () => hotelApi.quote(request as HotelQuoteRequest),
    enabled: request !== null,
    staleTime: 30_000,
    gcTime: 2 * MINUTE,
    placeholderData: keepPreviousData,
  });
}

export function usePackageQuote(request: PackageQuoteRequest | null) {
  return useQuery({
    queryKey: request ? bookingKeys.packageQuote(request) : bookingKeys.all,
    queryFn: () => packageApi.quote(request as PackageQuoteRequest),
    enabled: request !== null,
    staleTime: 30_000,
    gcTime: 2 * MINUTE,
    placeholderData: keepPreviousData,
  });
}

export function usePaymentsConfig(bookingRef?: string) {
  return useQuery({
    queryKey: bookingKeys.payments(bookingRef),
    queryFn: () => paymentsApi.config(bookingRef),
    staleTime: MINUTE,
  });
}

/** One of the customer's own bookings. The backend scopes it to them and answers 404 for anyone else's. */
export function useBooking(kind: BookingKind | null, ref: string | null, enabled = true) {
  return useQuery<AnyBooking>({
    queryKey: bookingKeys.one(kind ?? 'hotel', ref ?? ''),
    queryFn: () => (kind === 'hotel' ? hotelApi.get(ref as string) : packageApi.get(ref as string)),
    enabled: enabled && (kind === 'hotel' || kind === 'package') && ref !== null,
    staleTime: 0,
  });
}

export interface BookingRow {
  kind: 'hotel' | 'package';
  booking: HotelBooking | PackageBooking;
}

/** Every hotel and package booking, newest first. Flights are not offered in the app. */
export function useMyBookings() {
  const { hasSession } = useAuth();
  return useQuery({
    queryKey: bookingKeys.mine(),
    enabled: hasSession,
    staleTime: 15_000,
    queryFn: async (): Promise<BookingRow[]> => {
      const [hotels, packages] = await Promise.all([hotelApi.list(), packageApi.list()]);
      const rows: BookingRow[] = [
        ...hotels.map((booking) => ({ kind: 'hotel' as const, booking })),
        ...packages.map((booking) => ({ kind: 'package' as const, booking })),
      ];
      return rows.sort((a, b) => (a.booking.created_at < b.booking.created_at ? 1 : -1));
    },
  });
}
