/**
 * Calendar-date helpers.
 *
 * A booking date is a DATE, not an instant: "12 November" means 12 November
 * wherever the phone is. Dates travel as ISO `YYYY-MM-DD` strings, exactly as
 * the backend's `dt.date` fields expect, and are built from local calendar
 * parts. `new Date('2026-11-12')` is deliberately never used: it parses as UTC
 * midnight and renders as the previous day west of Greenwich.
 */
export type ISODate = string;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isISODate(value: unknown): value is ISODate {
  if (typeof value !== 'string') return false;
  const m = ISO_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
}

/** A local-noon Date for an ISO string (noon dodges DST edges). */
export function parseISODate(value: ISODate): Date {
  const m = ISO_RE.exec(value);
  if (!m) throw new Error(`Not an ISO date: ${value}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
}

export function toISODate(date: Date): ISODate {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function todayISO(now: Date = new Date()): ISODate {
  return toISODate(now);
}

export function addDays(value: ISODate, days: number): ISODate {
  const d = parseISODate(value);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/** Whole nights between two dates; 0 when out is not after in. */
export function nightsBetween(checkIn: ISODate, checkOut: ISODate): number {
  const ms = parseISODate(checkOut).getTime() - parseISODate(checkIn).getTime();
  return Math.max(0, Math.round(ms / 86_400_000));
}

/** "Thu, 5 Nov" */
export function formatShortDate(value: ISODate): string {
  const d = parseISODate(value);
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "5 Nov 2026" */
export function formatLongDate(value: ISODate): string {
  const d = parseISODate(value);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "November 2026" for a calendar header; month is 0-11. */
export function formatMonthYear(year: number, month: number): string {
  return `${MONTHS_LONG[month]} ${year}`;
}

/** Days in a month; month is 0-11. */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** Weekday of the 1st, 0 = Sunday. */
export function firstWeekday(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

export const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;
