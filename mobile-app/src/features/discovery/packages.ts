import type { PackageSummary } from '@/types/discovery';
import { compareMoney } from '@/utils/money';

/**
 * What a package card should say about price and dates.
 *
 * The API gives two prices, and they differ in an important way:
 *  - `priceFrom` is the lowest price across ALL the package's departures,
 *    including ones that have already left, so it can be well below anything
 *    that can still be booked (Goa: priceFrom 21,900 against 30,900 on the next
 *    departure).
 *  - `price_next` is the price on the soonest bookable departure, and is null
 *    whenever no departure is scheduled.
 *
 * So: with a next departure, lead with ITS price and date. Without one, show the
 * base price and say plainly that no departure date is listed.
 */
export interface PackagePricing {
  /** Decimal string, as sent. */
  amount: string;
  /** "Next departure" when `amount` is that departure's price, else "From". */
  label: 'Next departure from' | 'From';
  /** ISO date, when a departure is scheduled. */
  nextDeparture: string | null;
}

export function packagePricing(p: PackageSummary): PackagePricing {
  if (p.next_departure && p.price_next) {
    return { amount: p.price_next, label: 'Next departure from', nextDeparture: p.next_departure };
  }
  return { amount: p.priceFrom, label: 'From', nextDeparture: null };
}

/**
 * "Goa, India", but just "Thailand" when the destination and the country are the
 * same word (the data has several such packages).
 */
export function packagePlace(p: Pick<PackageSummary, 'destination' | 'country'>): string {
  const destination = (p.destination ?? '').trim();
  const country = (p.country ?? '').trim();
  if (!destination) return country;
  if (!country || country.toLowerCase() === destination.toLowerCase()) return destination;
  return `${destination}, ${country}`;
}

export function packageDuration(p: PackageSummary): string {
  const nights = p.nights ?? Math.max(p.days - 1, 0);
  return `${nights} night${nights === 1 ? '' : 's'} / ${p.days} day${p.days === 1 ? '' : 's'}`;
}

export type PackageSort = 'recommended' | 'price_asc' | 'price_desc' | 'soonest' | 'duration';

export const PACKAGE_SORTS: { value: PackageSort; label: string }[] = [
  { value: 'recommended', label: 'Recommended' },
  { value: 'soonest', label: 'Soonest departure' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
  { value: 'duration', label: 'Duration' },
];

const price = (p: PackageSummary) => packagePricing(p).amount;

/** Packages with a scheduled departure come before ones without, then soonest. */
function bySoonest(a: PackageSummary, b: PackageSummary): number {
  if (a.next_departure === b.next_departure) return 0;
  if (!a.next_departure) return 1;
  if (!b.next_departure) return -1;
  return a.next_departure < b.next_departure ? -1 : 1;
}

export function sortPackages(packages: readonly PackageSummary[], sort: PackageSort): PackageSummary[] {
  const list = [...packages];
  switch (sort) {
    case 'price_asc':
      return list.sort((a, b) => compareMoney(price(a), price(b)));
    case 'price_desc':
      return list.sort((a, b) => compareMoney(price(b), price(a)));
    case 'soonest':
      return list.sort((a, b) => bySoonest(a, b) || compareMoney(price(a), price(b)));
    case 'duration':
      return list.sort((a, b) => a.days - b.days || compareMoney(price(a), price(b)));
    case 'recommended':
    default:
      // Bookable now beats "ask us", then the soonest, then the cheaper.
      return list.sort((a, b) => bySoonest(a, b) || compareMoney(price(a), price(b)) || a.name.localeCompare(b.name));
  }
}

/** The packages the Home screen leads with. */
export function pickFeaturedPackages(packages: readonly PackageSummary[], count = 4): PackageSummary[] {
  return sortPackages(packages, 'recommended').slice(0, count);
}

export const TRIP_TYPES = [
  { value: undefined, label: 'All' },
  { value: 'domestic', label: 'Domestic' },
  { value: 'international', label: 'International' },
] as const;
