import { addDays, isISODate, nightsBetween, todayISO, type ISODate } from '@/utils/dates';

/**
 * The dates of a hotel stay and the rules that tie them together.
 *
 * A stay needs at least one night, never starts in the past (the backend refuses
 * that too), and can be booked up to a year ahead here. Check-out is always at
 * least a day after check-in: moving check-in past check-out drags check-out
 * along rather than leaving an impossible range on screen.
 */
export const MAX_ADVANCE_DAYS = 365;
export const MAX_NIGHTS = 30;

export interface StayDates {
  checkIn: ISODate;
  checkOut: ISODate;
}

export function defaultStay(now: Date = new Date()): StayDates {
  const checkIn = addDays(todayISO(now), 1);
  return { checkIn, checkOut: addDays(checkIn, 1) };
}

export function maxDate(now: Date = new Date()): ISODate {
  return addDays(todayISO(now), MAX_ADVANCE_DAYS);
}

export function setCheckIn(stay: StayDates, checkIn: ISODate): StayDates {
  const checkOut = stay.checkOut > checkIn ? stay.checkOut : addDays(checkIn, 1);
  return { checkIn, checkOut };
}

export function setCheckOut(stay: StayDates, checkOut: ISODate): StayDates {
  return { checkIn: stay.checkIn, checkOut: checkOut > stay.checkIn ? checkOut : addDays(stay.checkIn, 1) };
}

export type StayProblem = 'invalid' | 'past' | 'order' | 'too_long';

/** What is wrong with a pair of dates, or null. */
export function stayProblem(stay: StayDates, now: Date = new Date()): StayProblem | null {
  if (!isISODate(stay.checkIn) || !isISODate(stay.checkOut)) return 'invalid';
  if (stay.checkIn < todayISO(now)) return 'past';
  if (stay.checkOut <= stay.checkIn) return 'order';
  if (nightsBetween(stay.checkIn, stay.checkOut) > MAX_NIGHTS) return 'too_long';
  return null;
}

/** Read stay dates out of untrusted route params; fall back to the default for anything off. */
export function stayFromParams(
  params: { checkIn?: string; checkOut?: string },
  now: Date = new Date(),
): StayDates | null {
  const { checkIn, checkOut } = params;
  if (!checkIn || !checkOut) return null;
  const stay = { checkIn, checkOut };
  return stayProblem(stay, now) === null ? stay : null;
}
