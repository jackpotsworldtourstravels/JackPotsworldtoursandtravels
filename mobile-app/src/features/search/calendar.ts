import { daysInMonth, firstWeekday } from '@/utils/dates';

/** A month as weeks of seven cells, `null` where the grid is padding. Weeks start on Sunday. */
export function buildMonthGrid(year: number, month: number): (number | null)[][] {
  const lead = firstWeekday(year, month);
  const total = daysInMonth(year, month);
  const cells: (number | null)[] = [...Array<null>(lead).fill(null)];
  for (let d = 1; d <= total; d += 1) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Move a (year, month) pair by whole months; month is 0-11. */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + month + delta;
  return { year: Math.floor(index / 12), month: ((index % 12) + 12) % 12 };
}
