import type {
  Coupon,
  Destination,
  DestinationAttraction,
  DestinationHotelItem,
  DestinationHotelsPage,
  HotelListItem,
  PackageSummary,
} from '@/types/discovery';

/**
 * Fixtures copied from the production API's real responses (2026-10-21), so the
 * tests exercise the shapes the backend actually sends, including its quirks:
 * the two hotel endpoints disagree on field names and on string versus number,
 * and a package's `priceFrom` can be far below its next departure's price.
 */
export const destinations: Destination[] = [
  { id: 'goa', name: 'Goa', slug: 'goa', country: 'India', image: 'goa' },
  { id: 'hyderabad', name: 'Hyderabad', slug: 'hyderabad', country: 'India', image: 'hyderabad' },
  { id: 'dubai', name: 'Dubai', slug: 'dubai', country: 'United Arab Emirates', image: 'dubai' },
  { id: 'bali', name: 'Bali', slug: 'bali', country: 'Indonesia', image: 'bali' },
];

export const attraction: DestinationAttraction = {
  id: 'hyderabad__charminar',
  destination_id: 'hyderabad',
  name: 'Charminar',
  slug: 'charminar',
  description: 'The 16th-century four-minaret monument at the heart of the old city.',
  image: null,
  area_id: 'hyderabad__tank-bund',
  area_name: 'Tank Bund',
  hotel_count: 1,
};

function listHotel(over: Partial<HotelListItem> & Pick<HotelListItem, 'id' | 'name' | 'location' | 'pricePerNight'>): HotelListItem {
  return {
    image: 'taj-palace',
    stars: 4,
    guest_rating: null,
    distanceKm: null,
    amenities: ['Free Wi-Fi', 'Pool'],
    cancellation_policy: null,
    meal_plans: [],
    free_cancellation: true,
    source: 'seed',
    hotelbeds_code: null,
    provider_images: [],
    ...over,
  };
}

/** `GET /api/customer/hotels`, as production returns it. Note the seed `image` keys: they mislead. */
export const hotelList: HotelListItem[] = [
  listHotel({ id: '1', name: 'Taj Palace', location: 'Banjara Hills, Hyderabad', pricePerNight: '12500.00', stars: 5, guest_rating: '4.6', image: 'taj-palace' }),
  listHotel({ id: '2', name: 'Novotel Hyderabad', location: 'HITEC City, Hyderabad', pricePerNight: '8200.00', stars: 4, guest_rating: '4.3', image: 'novotel-hyderabad' }),
  listHotel({ id: '3', name: 'Hyatt Regency', location: 'Road No. 2, Hyderabad', pricePerNight: '9600.00', stars: 5, guest_rating: '4.5', image: 'hyatt-regency', free_cancellation: false }),
  listHotel({ id: '4', name: 'Radisson', location: 'Gachibowli, Hyderabad', pricePerNight: '6400.00', stars: 4, guest_rating: '4.1', image: 'radisson' }),
  listHotel({ id: '5', name: 'Marriott', location: 'Tank Bund, Hyderabad', pricePerNight: '11200.00', stars: 5, guest_rating: '4.4', image: 'marriott' }),
  listHotel({ id: '6', name: 'Novotel Bengaluru', location: 'Outer Ring Road, Bengaluru', pricePerNight: '7300.00', stars: 4, guest_rating: '4.2', image: 'novotel-bengaluru' }),
  listHotel({ id: '7', name: 'TEST PROPERTY - payment verification', location: 'Internal test listing - not a real stay', pricePerNight: '50.00', stars: 3, guest_rating: null }),
];

function destHotel(over: Partial<DestinationHotelItem> & Pick<DestinationHotelItem, 'id' | 'name' | 'location' | 'price_per_night'>): DestinationHotelItem {
  return {
    image: 'radisson',
    stars: 4,
    guest_rating: null,
    address: null,
    city: null,
    description: null,
    amenities: ['Free Wi-Fi', 'Breakfast'],
    currency: 'INR',
    free_cancellation: true,
    location_id: null,
    location_name: null,
    distance_km: null,
    ...over,
  };
}

/** `GET /destinations/hyderabad/hotels`: price and rating are JSON NUMBERS here. */
export const hyderabadPage: DestinationHotelsPage = {
  destination: destinations[1],
  locations: [
    { id: 'hyderabad__banjara-hills', name: 'Banjara Hills', slug: 'banjara-hills' },
    { id: 'hyderabad__gachibowli', name: 'Gachibowli', slug: 'gachibowli' },
  ],
  hotels: [
    destHotel({ id: '4', name: 'Radisson', location: 'Gachibowli, Hyderabad', price_per_night: 6400.0, guest_rating: 4.1, location_name: 'Gachibowli' }),
    destHotel({ id: '2', name: 'Novotel Hyderabad', location: 'HITEC City, Hyderabad', price_per_night: 8200.0, guest_rating: 4.3 }),
    destHotel({ id: '1', name: 'Taj Palace', location: 'Banjara Hills, Hyderabad', price_per_night: 12500.5, stars: 5, guest_rating: 4.6 }),
  ],
  page: 1,
  page_size: 24,
  total: 3,
};

export const emptyGoaPage: DestinationHotelsPage = {
  destination: destinations[0],
  locations: [],
  hotels: [],
  page: 1,
  page_size: 24,
  total: 0,
};

function pkg(over: Partial<PackageSummary> & Pick<PackageSummary, 'id' | 'name' | 'priceFrom'>): PackageSummary {
  return {
    destination: 'Goa',
    country: 'India',
    nights: 3,
    days: 4,
    trip_type: 'domestic',
    hotel_category: null,
    rating: null,
    rating_count: null,
    rating_source: null,
    highlights: [],
    inclusions: ['Daily breakfast'],
    image: 'goa',
    departure_months: [],
    next_departure: null,
    price_next: null,
    blurb: 'A few days by the sea.',
    is_international: false,
    category: 'holiday',
    ...over,
  };
}

export const packages: PackageSummary[] = [
  // priceFrom (21,900) is a departure that has already left; the next one costs 30,900.
  pkg({ id: '7', name: 'Goa', priceFrom: '21900.00', next_departure: '2026-10-24', price_next: '30900.00', departure_months: ['2026-10'] }),
  pkg({ id: '10', name: 'North Goa Heritage Tour', priceFrom: '22000.00', image: 'goa__fort-aguada' }),
  pkg({ id: '8', name: 'Goa Beach Escape', priceFrom: '25000.00', nights: 4, days: 5, image: 'goa__palolem-beach' }),
  pkg({
    id: '12', name: 'Dubai', destination: 'Dubai', country: 'United Arab Emirates', image: 'dubai', priceFrom: '45000.00',
    trip_type: 'international', is_international: true, nights: 4, days: 5, next_departure: '2026-10-24', price_next: '52000.00',
  }),
];

export const coupons = {
  hotel: [{ code: 'STAYMORE', title: 'Up to 40% off premium hotel stays', description: 'Free breakfast included.', discount_type: 'percent', discount_value: '40.00' }] as Coupon[],
  package: [
    { code: 'FAMILYFUN', title: 'Kids stay & fly free this summer', description: null, discount_type: 'percent', discount_value: '15.00' },
    { code: 'TOGETHER25', title: 'Romantic getaways', description: 'Candlelight dinners.', discount_type: 'percent', discount_value: '25.50' },
  ] as Coupon[],
  flight: [{ code: 'FLYHIGH30', title: 'Flat 30% off on domestic flights', description: null, discount_type: 'percent', discount_value: '30.00' }] as Coupon[],
  cruise: [{ code: 'CRUISE2000', title: 'Cashback', description: null, discount_type: 'flat', discount_value: '2000.00' }] as Coupon[],
};
