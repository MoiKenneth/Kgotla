import { country } from '../countries/index.js';
import { badRequest } from './errors.js';

/**
 * Parse an amount in the cell's currency ("150", "150.5", "R 150", 150.25)
 * into integer minor units (thebe, cents, ngwee), exactly.
 */
export function toThebe(v: unknown): number {
  const sym = country().currency.symbol.replace(/[$]/g, '\\$');
  const s = typeof v === 'number' ? v.toFixed(2) : String(v ?? '').trim().replace(new RegExp(`^(${sym}|${country().currency.code})\\s*`, 'i'), '').replace(/,/g, '');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw badRequest('invalid_amount', 'Amount must be a number with at most 2 decimals');
  const t = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (t <= 0) throw badRequest('invalid_amount', 'Amount must be more than zero');
  return t;
}

/** Format minor units as "P 1,234.50", "R 1,234.50", "US$ 12.50" (negative with a minus sign). */
export function fmt(thebe: number): string {
  const neg = thebe < 0;
  const a = Math.abs(thebe);
  const whole = Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = String(a % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${country().currency.symbol} ${whole}.${cents}`;
}
