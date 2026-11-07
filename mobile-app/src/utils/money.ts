/**
 * Display formatting for money.
 *
 * The backend sends amounts as decimal STRINGS ("12500.00") precisely so a
 * float never touches them. This keeps them strings: it groups the integer part
 * by hand and leaves the digits exactly as sent. Nothing here parses, rounds or
 * sums, and nothing in the app should either: the backend prices everything.
 *
 * A few discovery endpoints still send a JSON number (`price_per_night: 6400.0`
 * on the destination hotels page). A number is stringified without arithmetic.
 *
 * Mirrors `moneyStr()` in frontend/shared/formatters.js, including Indian
 * grouping (27,14,760), so a price reads the same in the app and on the site.
 */
export interface MoneyOptions {
  /** ISO currency code. INR renders as the rupee sign. */
  currency?: string;
  /** What to show for a missing value. */
  dash?: string;
  /** Drop a ".00" fraction ("₹12,500" not "₹12,500.00"). Default true. */
  compact?: boolean;
}

const SYMBOLS: Record<string, string> = { INR: '₹' };

function plainDecimal(value: string | number): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  const raw = value.trim();
  return /^-?\d+(\.\d+)?$/.test(raw) ? raw : null;
}

/**
 * A number from the few endpoints that send one, as the plain decimal string
 * the rest of the app handles. No rounding beyond the two places a rupee has.
 * Returns null for anything that is not a plain decimal.
 */
export function toDecimalString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return plainDecimal(value);
}

/**
 * Order two amounts WITHOUT turning them into floats: compare the integer
 * parts by length then digit, then the fractions padded to equal length.
 * Returns negative, zero or positive like `Array.sort`. An unparseable amount
 * sorts last, so a missing price never floats to the top of "cheapest first".
 */
export function compareMoney(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): number {
  const x = toDecimalString(a);
  const y = toDecimalString(b);
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;

  const split = (d: string) => {
    const negative = d.startsWith('-');
    const [whole, fraction = ''] = (negative ? d.slice(1) : d).split('.');
    return { negative, whole: whole.replace(/^0+(?=\d)/, ''), fraction };
  };
  const p = split(x);
  const q = split(y);
  if (p.negative !== q.negative) return p.negative ? -1 : 1;

  const sign = p.negative ? -1 : 1;
  if (p.whole.length !== q.whole.length) return sign * (p.whole.length - q.whole.length);
  if (p.whole !== q.whole) return sign * (p.whole < q.whole ? -1 : 1);
  const width = Math.max(p.fraction.length, q.fraction.length);
  const pf = p.fraction.padEnd(width, '0');
  const qf = q.fraction.padEnd(width, '0');
  if (pf === qf) return 0;
  return sign * (pf < qf ? -1 : 1);
}

export function formatMoney(
  value: string | number | null | undefined,
  { currency = 'INR', dash = '—', compact = true }: MoneyOptions = {},
): string {
  if (value === null || value === undefined || value === '') return dash;
  const decimal = plainDecimal(value);
  if (decimal === null) return dash;

  const negative = decimal.startsWith('-');
  const [whole, rawFraction = ''] = (negative ? decimal.slice(1) : decimal).split('.');
  // `(\d{2})*` and not `+`: the comma before the final triple has no pair
  // after it, so requiring a pair would skip it and render 27,14760.
  const grouped = whole.replace(/\B(?=(\d{2})*(\d{3})$)/g, ',');
  const fraction = compact && /^0*$/.test(rawFraction) ? '' : rawFraction;

  const code = currency.toUpperCase();
  const symbol = SYMBOLS[code] ?? `${code} `;
  return `${negative ? '-' : ''}${symbol}${grouped}${fraction ? `.${fraction}` : ''}`;
}
