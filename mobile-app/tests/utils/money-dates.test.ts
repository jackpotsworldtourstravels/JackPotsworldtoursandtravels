import {
  WEEKDAY_LABELS,
  addDays,
  daysInMonth,
  firstWeekday,
  formatLongDate,
  formatShortDate,
  isISODate,
  nightsBetween,
  parseISODate,
  toISODate,
} from '@/utils/dates';
import { compareMoney, formatMoney, toDecimalString } from '@/utils/money';

describe('formatMoney', () => {
  it('groups the Indian way and drops a .00 fraction', () => {
    expect(formatMoney('12500.00')).toBe('₹12,500');
    expect(formatMoney('2714760')).toBe('₹27,14,760');
    expect(formatMoney('999')).toBe('₹999');
    expect(formatMoney('1000')).toBe('₹1,000');
    expect(formatMoney('100000')).toBe('₹1,00,000');
  });

  it('keeps real paise exactly as sent, never rounding', () => {
    expect(formatMoney('24500.50')).toBe('₹24,500.50');
    expect(formatMoney('0.99')).toBe('₹0.99');
    expect(formatMoney('12500.00', { compact: false })).toBe('₹12,500.00');
  });

  it('formats the JSON numbers a few endpoints still send', () => {
    expect(formatMoney(6400)).toBe('₹6,400');
    expect(formatMoney(12500.5)).toBe('₹12,500.50');
  });

  it('shows a dash rather than NaN for anything missing or malformed', () => {
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(undefined)).toBe('—');
    expect(formatMoney('')).toBe('—');
    expect(formatMoney('abc')).toBe('—');
    expect(formatMoney('12,500')).toBe('—');
    expect(formatMoney(Number.NaN)).toBe('—');
  });

  it('handles another currency and negatives', () => {
    expect(formatMoney('150.00', { currency: 'USD' })).toBe('USD 150');
    expect(formatMoney('-500.00')).toBe('-₹500');
  });

  it('does not lose precision on amounts a float cannot hold', () => {
    expect(formatMoney('9007199254740993.10')).toBe('₹9,00,71,99,25,47,40,993.10');
  });
});

describe('compareMoney', () => {
  it('orders by value without parsing', () => {
    expect(compareMoney('900', '1000')).toBeLessThan(0);
    expect(compareMoney('12500.00', '9600.00')).toBeGreaterThan(0);
    expect(compareMoney('100', '100.00')).toBe(0);
    expect(compareMoney('100.10', '100.9')).toBeLessThan(0);
    expect(compareMoney('007', '7')).toBe(0);
  });

  it('is exact where floats would not be', () => {
    expect(compareMoney('9007199254740993', '9007199254740992')).toBeGreaterThan(0);
  });

  it('sorts a missing or malformed price last', () => {
    expect(compareMoney(null, '10')).toBeGreaterThan(0);
    expect(compareMoney('10', undefined)).toBeLessThan(0);
    expect(compareMoney(null, 'x')).toBe(0);
  });

  it('handles negatives', () => {
    expect(compareMoney('-5', '3')).toBeLessThan(0);
    expect(compareMoney('-10', '-5')).toBeLessThan(0);
  });

  it('works on numbers from the destination endpoint too', () => {
    expect(compareMoney(6400, '8200.00')).toBeLessThan(0);
    expect(toDecimalString(6400.0)).toBe('6400');
    expect(toDecimalString(null)).toBeNull();
  });
});

describe('dates', () => {
  it('round-trips an ISO date without drifting a day', () => {
    for (const iso of ['2026-01-01', '2026-03-29', '2026-10-25', '2026-12-31', '2028-02-29']) {
      expect(toISODate(parseISODate(iso))).toBe(iso);
    }
  });

  it('validates real calendar dates only', () => {
    expect(isISODate('2026-02-28')).toBe(true);
    expect(isISODate('2026-02-30')).toBe(false);
    expect(isISODate('2026-13-01')).toBe(false);
    expect(isISODate('2026-1-1')).toBe(false);
    expect(isISODate('not a date')).toBe(false);
    expect(isISODate(20261101)).toBe(false);
    expect(isISODate('2028-02-29')).toBe(true);
    expect(isISODate('2027-02-29')).toBe(false);
  });

  it('adds days across month, year and leap boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('counts nights, never negative', () => {
    expect(nightsBetween('2026-11-05', '2026-11-08')).toBe(3);
    expect(nightsBetween('2026-11-05', '2026-11-05')).toBe(0);
    expect(nightsBetween('2026-11-08', '2026-11-05')).toBe(0);
    expect(nightsBetween('2026-10-30', '2026-11-02')).toBe(3);
  });

  it('formats without an off-by-one', () => {
    expect(formatShortDate('2026-11-05')).toBe('Thu, 5 Nov');
    expect(formatLongDate('2026-11-05')).toBe('5 Nov 2026');
    expect(formatShortDate('2026-01-01')).toBe('Thu, 1 Jan');
  });

  it('knows month lengths and the weekday a month starts on', () => {
    expect(daysInMonth(2026, 1)).toBe(28);
    expect(daysInMonth(2028, 1)).toBe(29);
    expect(daysInMonth(2026, 9)).toBe(31);
    expect(firstWeekday(2026, 10)).toBe(0); // 1 Nov 2026 is a Sunday
    expect(WEEKDAY_LABELS).toHaveLength(7);
  });

  it('refuses to parse garbage rather than guessing', () => {
    expect(() => parseISODate('05/11/2026')).toThrow();
  });
});
