import {
  filterHotels,
  fromDestinationItem,
  fromListItem,
  pickFeatured,
  sortHotels,
  type HotelCardModel,
} from '@/features/discovery/hotels';
import {
  packageDuration,
  packagePlace,
  packagePricing,
  pickFeaturedPackages,
  sortPackages,
} from '@/features/discovery/packages';

import { hotelList, hyderabadPage, packages } from '../fixtures/discovery';

const models = hotelList.map(fromListItem);
const names = (list: { name: string }[]) => list.map((h) => h.name);

describe('hotel normalisation', () => {
  it('reads the list endpoint’s string price and rating', () => {
    expect(fromListItem(hotelList[0])).toMatchObject({
      id: '1',
      stars: 5,
      rating: 4.6,
      pricePerNight: '12500.00',
      currency: 'INR',
      freeCancellation: true,
    });
  });

  it('reads the destination endpoint’s numeric price and rating into the SAME shape', () => {
    const [radisson, , taj] = hyderabadPage.hotels.map(fromDestinationItem);
    expect(radisson).toMatchObject({ pricePerNight: '6400', rating: 4.1, location: 'Gachibowli, Hyderabad' });
    // A numeric price keeps its paise as a decimal string, never a float expression.
    expect(taj.pricePerNight).toBe('12500.50');
  });

  it('treats a missing or zero rating as unrated, not as 0.0', () => {
    expect(fromListItem({ ...hotelList[0], guest_rating: null }).rating).toBeNull();
    expect(fromListItem({ ...hotelList[0], guest_rating: '0' }).rating).toBeNull();
    expect(fromListItem({ ...hotelList[0], guest_rating: 'n/a' }).rating).toBeNull();
  });

  it('falls back to area and city when a destination hotel has no location line', () => {
    const h = { ...hyderabadPage.hotels[0], location: null, location_name: 'Gachibowli', city: 'Hyderabad' };
    expect(fromDestinationItem(h).location).toBe('Gachibowli, Hyderabad');
  });
});

describe('sortHotels', () => {
  it('orders by price both ways without parsing', () => {
    expect(names(sortHotels(models, 'price_asc')).slice(0, 3)).toEqual([
      'TEST PROPERTY - payment verification',
      'Radisson',
      'Novotel Bengaluru',
    ]);
    expect(names(sortHotels(models, 'price_desc'))[0]).toBe('Taj Palace');
  });

  it('puts a hotel with no price last in either direction', () => {
    const noPrice: HotelCardModel = { ...models[0], id: 'x', name: 'No Price', pricePerNight: null };
    expect(sortHotels([noPrice, ...models], 'price_asc').at(-1)?.name).toBe('No Price');
    expect(sortHotels([noPrice, ...models], 'price_desc').at(-1)?.name).toBe('No Price');
  });

  it('puts the best-rated first and unrated hotels after every rated one', () => {
    const order = names(sortHotels(models, 'rating'));
    expect(order[0]).toBe('Taj Palace');
    expect(order.at(-1)).toBe('TEST PROPERTY - payment verification');
  });

  it('recommended is rating, then stars, then price', () => {
    const order = names(sortHotels(models, 'recommended'));
    expect(order.slice(0, 3)).toEqual(['Taj Palace', 'Hyatt Regency', 'Marriott']);
  });

  it('never mutates what it is given', () => {
    const before = names(models);
    sortHotels(models, 'price_desc');
    expect(names(models)).toEqual(before);
  });
});

describe('filterHotels and pickFeatured', () => {
  it('filters by stars and by free cancellation', () => {
    expect(filterHotels(models, { minStars: 5 }).map((h) => h.name)).toEqual(['Taj Palace', 'Hyatt Regency', 'Marriott']);
    expect(filterHotels(models, { freeCancellationOnly: true }).map((h) => h.name)).not.toContain('Hyatt Regency');
    expect(filterHotels(models, {})).toHaveLength(models.length);
  });

  it('features the best few, so a stray unrated test listing stays out of the top', () => {
    const featured = pickFeatured(models, 4);
    expect(featured).toHaveLength(4);
    expect(names(featured)).not.toContain('TEST PROPERTY - payment verification');
  });
});

describe('package pricing', () => {
  const [goa, heritage] = packages;

  it('leads with the next departure’s price and date when there is one', () => {
    // priceFrom is 21,900 (a departure that has left); the customer can actually pay 30,900.
    expect(packagePricing(goa)).toEqual({ amount: '30900.00', label: 'Next departure from', nextDeparture: '2026-10-24' });
  });

  it('falls back to the base price, and says there is no date, when nothing is scheduled', () => {
    expect(packagePricing(heritage)).toEqual({ amount: '22000.00', label: 'From', nextDeparture: null });
  });

  it('does not trust price_next without a departure to go with it', () => {
    expect(packagePricing({ ...goa, next_departure: null })).toMatchObject({ amount: '21900.00', label: 'From' });
  });

  it('names the place once when destination and country are the same word', () => {
    expect(packagePlace({ destination: 'Goa', country: 'India' })).toBe('Goa, India');
    expect(packagePlace({ destination: 'Thailand', country: 'Thailand' })).toBe('Thailand');
    expect(packagePlace({ destination: 'thailand', country: 'Thailand ' })).toBe('thailand');
    expect(packagePlace({ destination: null, country: 'India' })).toBe('India');
    expect(packagePlace({ destination: 'Goa', country: null })).toBe('Goa');
    expect(packagePlace({ destination: null, country: null })).toBe('');
  });

  it('describes duration, deriving nights when the backend omits them', () => {
    expect(packageDuration(goa)).toBe('3 nights / 4 days');
    expect(packageDuration({ ...goa, nights: null, days: 5 })).toBe('4 nights / 5 days');
    expect(packageDuration({ ...goa, nights: 1, days: 2 })).toBe('1 night / 2 days');
  });
});

describe('sortPackages', () => {
  it('recommended puts packages with a departure first, then the soonest, then the cheaper', () => {
    expect(names(sortPackages(packages, 'recommended'))).toEqual([
      'Goa', // 24 Oct at 30,900
      'Dubai', // 24 Oct at 52,000
      'North Goa Heritage Tour', // no dates, 22,000
      'Goa Beach Escape', // no dates, 25,000
    ]);
  });

  it('sorts by the price the customer will actually pay, not the stale "from" price', () => {
    // Goa's priceFrom (21,900) is lowest, but its real price (30,900) is not.
    expect(names(sortPackages(packages, 'price_asc'))).toEqual([
      'North Goa Heritage Tour',
      'Goa Beach Escape',
      'Goa',
      'Dubai',
    ]);
    expect(names(sortPackages(packages, 'price_desc'))[0]).toBe('Dubai');
  });

  it('sorts by duration and never mutates the input', () => {
    const before = names(packages);
    expect(sortPackages(packages, 'duration')[0].days).toBe(4);
    expect(names(packages)).toEqual(before);
  });

  it('features at most the requested count', () => {
    expect(pickFeaturedPackages(packages, 2)).toHaveLength(2);
  });
});
