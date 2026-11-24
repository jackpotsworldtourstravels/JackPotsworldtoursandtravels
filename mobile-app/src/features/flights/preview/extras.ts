import type { TripDraft } from './draft';
import { seated } from './draft';
import { sampleTaxes } from './sample';

/**
 * Sample add-ons and their sample prices. Real ones come from each airline through the flight supplier and differ by
 * flight; these are placeholders so the screens can be reviewed. Meals and baggage apply to every flight of the trip.
 */

export type Diet = 'veg' | 'nonveg' | 'jain';

export interface Meal {
  id: string;
  name: string;
  description: string;
  diet: Diet;
  drink?: boolean;
  price: number;
}

export const MEALS: readonly Meal[] = [
  { id: 'paneer', name: 'Paneer tikka sandwich and a drink', description: 'Grilled paneer, mint chutney, with tea, coffee or juice', diet: 'veg', price: 350 },
  { id: 'biryani', name: 'Chicken biryani', description: 'Hyderabadi dum biryani with raita', diet: 'nonveg', price: 400 },
  { id: 'upma', name: 'Vegetable upma', description: 'With coconut chutney, light and warm', diet: 'veg', price: 300 },
  { id: 'jain', name: 'Jain fruit and nut box', description: 'No root vegetables, onion or garlic', diet: 'jain', price: 300 },
  { id: 'chai', name: 'Masala chai or coffee', description: 'Hot, freshly brewed', diet: 'veg', drink: true, price: 100 },
];

export const BAGGAGE_OPTIONS: readonly { kg: number; price: number }[] = [
  { kg: 3, price: 1350 },
  { kg: 5, price: 2250 },
  { kg: 10, price: 4500 },
  { kg: 15, price: 6750 },
  { kg: 20, price: 9000 },
  { kg: 30, price: 13500 },
];

export const PRIORITY_PRICE = 400;
export const INSURANCE_PRICE = 199;

/** Exit rows give extra legroom; the first rows are quicker off. Everything else is free to choose. */
export const SEAT_ROWS = { first: 3, last: 30, exit: [12, 13], front: [3, 4, 5] } as const;
export function seatPrice(seat: string): number {
  const row = Number(seat.replace(/\D/g, ''));
  if ((SEAT_ROWS.exit as readonly number[]).includes(row)) return 350;
  if ((SEAT_ROWS.front as readonly number[]).includes(row)) return 250;
  return 0;
}

export interface TripTotals {
  fares: number;
  taxes: number;
  seats: number;
  meals: number;
  baggage: number;
  priority: number;
  insurance: number;
  extras: number;
  total: number;
}

/** Everything the customer has picked, priced with the sample prices above. */
export function tripTotals(draft: TripDraft): TripTotals {
  const legs = draft.picks.length || 1;
  const payingPax = draft.passengers.filter((p) => p.type !== 'infant').length;
  const infants = draft.passengers.length - payingPax;
  // Infants travel on a lap: a tenth of the fare, as many airlines charge.
  const fares = draft.picks.reduce((sum, f) => sum + (f ? Number(f.price) * payingPax + Number(f.price) * 0.1 * infants : 0), 0);
  const taxes = sampleTaxes(fares);
  const seats = Object.values(draft.seats).reduce((sum, byPax) => sum + Object.values(byPax).reduce((s, seat) => s + seatPrice(seat), 0), 0);
  const meals = Object.values(draft.meals).reduce((sum, id) => sum + (MEALS.find((m) => m.id === id)?.price ?? 0), 0) * legs;
  const baggage = Object.values(draft.baggage).reduce((sum, kg) => sum + (BAGGAGE_OPTIONS.find((b) => b.kg === kg)?.price ?? 0), 0) * legs;
  const travellers = draft.passengers.filter(seated).length;
  const priority = draft.priority ? PRIORITY_PRICE * travellers : 0;
  const insurance = draft.insurance ? INSURANCE_PRICE * draft.passengers.length : 0;
  const extras = seats + meals + baggage + priority + insurance;
  return { fares: Math.round(fares), taxes, seats, meals, baggage, priority, insurance, extras, total: Math.round(fares) + taxes + extras };
}

export const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
