import type {
  Coupon,
  CouponProduct,
  Destination,
  DestinationAttraction,
  DestinationHotelsPage,
  DestinationLocation,
  HotelListItem,
  PackageQuery,
  PackageSummary,
} from '@/types/discovery';

import { http } from '../client';

const BASE = '/api/customer';

/**
 * Every discovery call is public (browsing before signing in is normal, as on
 * the website), so none of them sends the customer's token and none can
 * trigger a session refresh.
 */
const PUBLIC = { skipAuth: true } as const;

const seg = encodeURIComponent;

export const discoveryApi = {
  async destinations(): Promise<Destination[]> {
    const { data } = await http.get<Destination[]>(`${BASE}/destinations`, PUBLIC);
    return data;
  },

  /** 404 for an unknown destination; an empty list for a real one with none mapped. */
  async locations(destinationId: string): Promise<DestinationLocation[]> {
    const { data } = await http.get<DestinationLocation[]>(
      `${BASE}/destinations/${seg(destinationId)}/locations`,
      PUBLIC,
    );
    return data;
  },

  async attractions(destinationId: string): Promise<DestinationAttraction[]> {
    const { data } = await http.get<DestinationAttraction[]>(
      `${BASE}/destinations/${seg(destinationId)}/attractions`,
      PUBLIC,
    );
    return data;
  },

  /**
   * Hotels mapped to a destination. Catalogue, NOT availability: `price_per_night`
   * is indicative, and nothing about a date is checked here.
   */
  async destinationHotels(
    destinationId: string,
    options: { locationId?: string; page?: number; pageSize?: number } = {},
  ): Promise<DestinationHotelsPage> {
    const { data } = await http.get<DestinationHotelsPage>(
      `${BASE}/destinations/${seg(destinationId)}/hotels`,
      {
        ...PUBLIC,
        params: {
          location_id: options.locationId,
          page: options.page,
          page_size: options.pageSize,
        },
      },
    );
    return data;
  },

  /** Every active property. Filtering is the caller's job; the endpoint takes no parameters. */
  async hotels(): Promise<HotelListItem[]> {
    const { data } = await http.get<HotelListItem[]>(`${BASE}/hotels`, PUBLIC);
    return data;
  },

  async packages(query: PackageQuery = {}): Promise<PackageSummary[]> {
    const { data } = await http.get<PackageSummary[]>(`${BASE}/packages`, { ...PUBLIC, params: query });
    return data;
  },

  /**
   * Active offers for one product line. The endpoint defaults to flights, so
   * the product is always named: asking without it would surface a flight offer
   * in an app that does not sell flights.
   */
  async coupons(product: CouponProduct): Promise<Coupon[]> {
    const { data } = await http.get<Coupon[]>(`${BASE}/coupons`, {
      ...PUBLIC,
      params: { product_type: product },
    });
    return data;
  },
};
