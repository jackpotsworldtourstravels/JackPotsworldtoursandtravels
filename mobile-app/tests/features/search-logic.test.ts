import { buildMonthGrid, shiftMonth } from '@/features/search/calendar';
import { filterByRegion, filterDestinations, findDestination } from '@/features/search/destinations';
import { DEFAULT_PARTY, normaliseParty, partySummary } from '@/features/search/party';
import {
  MAX_ADVANCE_DAYS,
  defaultStay,
  maxDate,
  setCheckIn,
  setCheckOut,
  stayFromParams,
  stayProblem,
} from '@/features/search/stay';
import { couponHeadline } from '@/features/discovery/cards';
import { addDays, todayISO } from '@/utils/dates';

import { coupons, destinations } from '../fixtures/discovery';

// A fixed "now" keeps every date assertion independent of the day the suite runs.
const NOW = new Date(2026, 9, 21, 15, 30); // 21 Oct 2026, mid-afternoon
const TODAY = '2026-10-21';

describe('party', () => {
  it('defaults to one room and two adults', () => {
    expect(DEFAULT_PARTY).toEqual({ rooms: 1, adults: 2, children: 0 });
    expect(partySummary(DEFAULT_PARTY)).toBe('1 room · 2 adults');
  });

  it('never allows fewer adults than rooms', () => {
    expect(normaliseParty({ rooms: 3, adults: 1, children: 0 })).toEqual({ rooms: 3, adults: 3, children: 0 });
  });

  it('clamps to the backend’s limits of 4 rooms, 32 adults and 16 children', () => {
    expect(normaliseParty({ rooms: 9, adults: 99, children: 99 })).toEqual({ rooms: 4, adults: 32, children: 16 });
    expect(normaliseParty({ rooms: 0, adults: 0, children: -3 })).toEqual({ rooms: 1, adults: 1, children: 0 });
    expect(normaliseParty({ rooms: Number.NaN, adults: Number.NaN, children: Number.NaN })).toEqual({ rooms: 1, adults: 1, children: 0 });
  });

  it('pluralises correctly', () => {
    expect(partySummary({ rooms: 1, adults: 1, children: 1 })).toBe('1 room · 1 adult · 1 child');
    expect(partySummary({ rooms: 2, adults: 4, children: 3 })).toBe('2 rooms · 4 adults · 3 children');
  });
});

describe('stay dates', () => {
  it('starts tomorrow for one night', () => {
    expect(defaultStay(NOW)).toEqual({ checkIn: '2026-10-22', checkOut: '2026-10-23' });
  });

  it('pushes check-out along when check-in moves past it', () => {
    const stay = defaultStay(NOW);
    expect(setCheckIn(stay, '2026-11-01')).toEqual({ checkIn: '2026-11-01', checkOut: '2026-11-02' });
    expect(setCheckIn({ checkIn: '2026-11-01', checkOut: '2026-11-10' }, '2026-11-03')).toEqual({
      checkIn: '2026-11-03',
      checkOut: '2026-11-10',
    });
  });

  it('keeps check-out after check-in', () => {
    const stay = { checkIn: '2026-11-05', checkOut: '2026-11-07' };
    expect(setCheckOut(stay, '2026-11-09').checkOut).toBe('2026-11-09');
    expect(setCheckOut(stay, '2026-11-05').checkOut).toBe('2026-11-06');
    expect(setCheckOut(stay, '2026-11-01').checkOut).toBe('2026-11-06');
  });

  it('names what is wrong with a range', () => {
    expect(stayProblem({ checkIn: '2026-10-22', checkOut: '2026-10-23' }, NOW)).toBeNull();
    expect(stayProblem({ checkIn: TODAY, checkOut: '2026-10-22' }, NOW)).toBeNull(); // today is allowed
    expect(stayProblem({ checkIn: '2026-10-20', checkOut: '2026-10-23' }, NOW)).toBe('past');
    expect(stayProblem({ checkIn: '2026-11-05', checkOut: '2026-11-05' }, NOW)).toBe('order');
    expect(stayProblem({ checkIn: '2026-11-05', checkOut: '2026-12-20' }, NOW)).toBe('too_long');
    expect(stayProblem({ checkIn: 'nope', checkOut: '2026-11-05' }, NOW)).toBe('invalid');
  });

  it('can be booked a year ahead and no further', () => {
    expect(maxDate(NOW)).toBe(addDays(TODAY, MAX_ADVANCE_DAYS));
    expect(todayISO(NOW)).toBe(TODAY);
  });

  it('reads stay dates out of route params, rejecting anything that is not a valid future stay', () => {
    expect(stayFromParams({ checkIn: '2026-11-05', checkOut: '2026-11-08' }, NOW)).toEqual({
      checkIn: '2026-11-05',
      checkOut: '2026-11-08',
    });
    expect(stayFromParams({ checkIn: '2026-11-05' }, NOW)).toBeNull();
    expect(stayFromParams({ checkIn: '2026-11-08', checkOut: '2026-11-05' }, NOW)).toBeNull();
    expect(stayFromParams({ checkIn: '2020-01-01', checkOut: '2020-01-03' }, NOW)).toBeNull();
    expect(stayFromParams({ checkIn: '<script>', checkOut: 'x' }, NOW)).toBeNull();
  });
});

describe('calendar grid', () => {
  it('lays November 2026 out from a Sunday, in whole weeks', () => {
    const weeks = buildMonthGrid(2026, 10);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0][0]).toBe(1);
    expect(weeks.flat().filter((d) => d !== null)).toHaveLength(30);
    expect(weeks).toHaveLength(5);
  });

  it('pads before the 1st and after the last day', () => {
    const weeks = buildMonthGrid(2026, 9); // October 2026 starts on a Thursday
    expect(weeks[0].slice(0, 4)).toEqual([null, null, null, null]);
    expect(weeks[0][4]).toBe(1);
    expect(weeks.flat().filter((d) => d !== null)).toHaveLength(31);
  });

  it('shifts across year boundaries both ways', () => {
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
    expect(shiftMonth(2026, 5, 0)).toEqual({ year: 2026, month: 5 });
    expect(shiftMonth(2026, 0, -13)).toEqual({ year: 2024, month: 11 });
  });
});

describe('destination search', () => {
  it('matches name or country, ignoring case and accents, keeping the backend’s order', () => {
    expect(filterDestinations(destinations, 'GOA').map((d) => d.id)).toEqual(['goa']);
    expect(filterDestinations(destinations, 'emirates').map((d) => d.id)).toEqual(['dubai']);
    expect(filterDestinations(destinations, '  ').map((d) => d.id)).toEqual(destinations.map((d) => d.id));
    expect(filterDestinations(destinations, 'zzz')).toEqual([]);
  });

  it('splits India from the rest', () => {
    expect(filterByRegion(destinations, 'india').map((d) => d.id)).toEqual(['goa', 'hyderabad']);
    expect(filterByRegion(destinations, 'international').map((d) => d.id)).toEqual(['dubai', 'bali']);
    expect(filterByRegion(destinations, 'all')).toHaveLength(4);
  });

  it('finds a destination by slug', () => {
    expect(findDestination(destinations, 'bali')?.name).toBe('Bali');
    expect(findDestination(destinations, 'atlantis')).toBeNull();
    expect(findDestination(undefined, 'goa')).toBeNull();
  });
});

describe('couponHeadline', () => {
  it('shows a percentage without trailing zeros, edited as a string', () => {
    expect(couponHeadline(coupons.hotel[0])).toBe('40% off');
    expect(couponHeadline(coupons.package[1])).toBe('25.5% off');
  });

  it('shows a flat amount in rupees', () => {
    expect(couponHeadline(coupons.cruise[0])).toBe('₹2,000 off');
  });

  it('has a safe fallback for a discount type it does not know', () => {
    expect(couponHeadline({ discount_type: 'bogo', discount_value: '1' })).toBe('Special offer');
  });
});
