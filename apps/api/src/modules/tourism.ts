import type pg from 'pg';
import { z } from 'zod';
import { config } from '../config.js';
import { country } from '../countries/index.js';
import { LISTINGS_MANAGE } from '../countries/partners.js';
import { COUNTRY_TOURISM, type ListingSeed } from '../countries/tourism.js';
import { many, one, tx, type Queryable } from '../db.js';
import { audit } from '../lib/audit.js';
import { hashSecret, reference } from '../lib/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { fmt } from '../lib/money.js';
import { notify } from '../lib/notify.js';
import { dayLabel, localDate, slotInstant, timeLabel } from '../lib/time.js';
import { enqueueEvent, subjectFor } from '../lib/webhooks.js';
import { ensureAccount, post, walletCode } from './ledger.js';
import { issueDocument } from './vault.js';

/**
 * Tourism: places to stay, safaris and tours, and national park entry.
 *
 * Stays and safaris come from hotels and tour operators onboarded through the
 * partner hub; parks belong to the country's parks agency. Every booking is
 * paid from the wallet through the confirmable-action path (PIN), puts a
 * voucher or park permit in the Vault, and can be cancelled for a full refund
 * until the listing's cut-off.
 */

export type Kind = 'stay' | 'safari' | 'park' | 'reserve' | 'driver';
export const KINDS: Kind[] = ['park', 'reserve', 'stay', 'safari', 'driver'];
export const CATEGORIES: Record<string, string[]> = { stay: ['lodge', 'hotel', 'camp', 'guesthouse'], driver: ['transfer', 'driver_guide'] };
/** Units priced per item regardless of length (a game drive, a transfer); the rest are per night or day. */
const flat = (unit: string) => unit === 'person' || unit === 'trip';
const MAX_AHEAD_DAYS = 365;

const addDays = (date: string, n: number) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10);
const unitWord = (unit: string) => ({ room_night: 'room per night', person_day: 'person per day', person: 'person', vehicle_day: 'vehicle per day', trip: 'vehicle, one way' } as Record<string, string>)[unit] ?? unit;

function view(r: any) {
  const rates = (r.rates as any[]).map((x) => ({ ...x, priceText: fmt(x.price) }));
  const from = Math.min(...rates.map((x) => x.price));
  return {
    id: r.id,
    kind: r.kind as Kind,
    category: r.category ?? null,
    name: r.name,
    region: r.region,
    description: r.description,
    highlights: r.highlights,
    unit: r.unit,
    unitText: unitWord(r.unit),
    rates,
    fromPrice: from,
    fromText: fmt(from),
    capacity: r.capacity,
    durationDays: r.duration_days,
    cancelHours: r.cancel_hours,
    provider: r.provider_name ?? r.agency,
    providerType: r.partner_id ? 'partner' : 'agency',
  };
}

const listingSql = `SELECT l.*, p.status AS partner_status, COALESCE(p.trading_name, i.name, l.agency) AS provider_name
  FROM tourism_listings l LEFT JOIN partners p ON p.id = l.partner_id LEFT JOIN issuers i ON i.id = l.agency`;

export async function listListings(db: Queryable, f: { kind?: string; region?: string; q?: string; category?: string }) {
  const rows = await many<any>(
    db,
    `${listingSql}
      WHERE l.active AND (l.partner_id IS NULL OR p.status = 'approved')
        AND ($1::text IS NULL OR l.kind = $1) AND ($2::text IS NULL OR l.region = $2)
        AND ($3::text IS NULL OR l.name ILIKE '%' || $3 || '%' OR l.region ILIKE '%' || $3 || '%' OR l.description ILIKE '%' || $3 || '%')
        AND ($4::text IS NULL OR l.category = $4)
      ORDER BY array_position(ARRAY['park','reserve','stay','safari','driver'], l.kind), l.name`,
    [f.kind || null, f.region || null, f.q?.trim() || null, f.category || null],
  );
  const regions = await many<{ region: string }>(db, `SELECT DISTINCT region FROM tourism_listings WHERE active ORDER BY region`);
  return { listings: rows.map(view), regions: regions.map((r) => r.region) };
}

async function listingRow(db: Queryable, id: string, lock = false) {
  const r = await one<any>(db, `${listingSql} WHERE l.id = $1 ${lock ? 'FOR UPDATE OF l' : ''}`, [id]);
  if (!r || !r.active) throw notFound('That listing is not available');
  return r;
}

/** Units left on each day in [start, start+days). */
async function remaining(db: Queryable, listingId: string, capacity: number, start: string, days: number) {
  const rows = await many<{ d: string; used: number }>(
    db,
    `SELECT gs::date AS d, COALESCE(sum(b.quantity),0)::int AS used
       FROM generate_series($2::date, $2::date + ($3::int - 1), interval '1 day') gs
       LEFT JOIN tourism_bookings b ON b.listing_id = $1 AND b.status = 'confirmed'
            AND gs::date >= b.start_date AND gs::date < b.start_date + b.days
      GROUP BY gs ORDER BY gs`,
    [listingId, start, days],
  );
  return rows.map((r) => ({ date: typeof r.d === 'string' ? r.d : new Date(r.d).toISOString().slice(0, 10), left: Math.max(0, capacity - r.used) }));
}

export async function listingDetail(db: Queryable, id: string, from?: string) {
  const r = await listingRow(db, id);
  const start = from && /^\d{4}-\d{2}-\d{2}$/.test(from) && from >= localDate() ? from : localDate();
  const days = await remaining(db, id, r.capacity, start, 14);
  return { ...view(r), availability: days.map((d) => ({ ...d, label: dayLabel(d.date) })) };
}

export const bookSchema = z.object({
  listingId: z.string().min(2).max(80),
  rateKey: z.string().min(1).max(30),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates look like 2026-11-14'),
  days: z.coerce.number().int().min(1).max(30).optional(),
  quantity: z.coerce.number().int().min(1).max(20),
});
export type BookInput = z.infer<typeof bookSchema>;

/** Price and dates for a booking. Pure: no availability check. */
export function quote(r: any, p: BookInput) {
  const rate = (r.rates as any[]).find((x) => x.key === p.rateKey);
  if (!rate) throw badRequest('invalid_rate', `Choose one of: ${(r.rates as any[]).map((x) => x.label).join(', ')}`);
  const today = localDate();
  if (p.startDate < today) throw badRequest('invalid_date', 'Choose a date from today onwards');
  if (p.startDate > addDays(today, MAX_AHEAD_DAYS)) throw badRequest('invalid_date', 'Bookings open up to a year ahead');
  const fixedLength = r.kind === 'safari' || flat(r.unit);
  const days = fixedLength ? r.duration_days : p.days ?? 1;
  if (!fixedLength && days > 14) throw badRequest('too_long', 'Book up to 14 nights or days at a time');
  if (p.quantity > r.capacity) throw badRequest('too_many', `At most ${r.capacity} ${r.unit === 'room_night' ? 'rooms' : r.unit === 'vehicle_day' || r.unit === 'trip' ? 'vehicles' : 'people'} per booking here`);
  const units = flat(r.unit) ? p.quantity : p.quantity * days;
  const total = rate.price * units;
  const end = addDays(p.startDate, days);
  const cutoff = new Date(slotInstant(p.startDate, '00:00').getTime() - r.cancel_hours * 3600_000);
  return { rate, days, units, total, end, cutoff };
}

function datesText(r: any, start: string, days: number) {
  if (r.kind === 'stay') return `${dayLabel(start)} → ${dayLabel(addDays(start, days))} · ${days} night${days > 1 ? 's' : ''}`;
  if (days === 1) return dayLabel(start);
  return `${dayLabel(start)} → ${dayLabel(addDays(start, days - 1))} · ${days} days`;
}

const qtyText = (r: any, n: number) =>
  r.unit === 'room_night' ? `${n} room${n > 1 ? 's' : ''}` : r.unit === 'vehicle_day' || r.unit === 'trip' ? `${n} vehicle${n > 1 ? 's' : ''}` : `${n} ${n > 1 ? 'people' : 'person'}`;
const qtyLabel = (r: any) => (r.unit === 'room_night' ? 'Rooms' : r.unit === 'vehicle_day' || r.unit === 'trip' ? 'Vehicles' : 'People');

/** Prepare step of the book_tourism action: validated read-back, nothing reserved yet. */
export async function prepareBooking(db: Queryable, p: BookInput) {
  const r = await listingRow(db, p.listingId);
  if (r.partner_id && r.partner_status !== 'approved') {
    throw conflict('provider_inactive', `${r.provider_name} is not taking bookings through Kgotla right now`);
  }
  const q = quote(r, p);
  const left = await remaining(db, r.id, r.capacity, p.startDate, q.days);
  if (left.some((d) => d.left < p.quantity)) throw conflict('sold_out', `Not enough space on ${dayLabel(left.find((d) => d.left < p.quantity)!.date)}. Try other dates.`);
  return {
    params: { listingId: r.id, rateKey: p.rateKey, startDate: p.startDate, days: q.days, quantity: p.quantity },
    label: `Book ${r.name} for ${fmt(q.total)}`,
    amount: q.total,
    readback: [
      ['Where', r.name],
      ['When', datesText(r, p.startDate, q.days)],
      [qtyLabel(r), `${qtyText(r, p.quantity)} · ${q.rate.label}`],
      ['Price', `${fmt(q.rate.price)} per ${unitWord(r.unit)}`],
      ['Total', fmt(q.total)],
      ['Free cancellation', q.cutoff.getTime() > Date.now() ? `Until ${dayLabel(q.cutoff)}, ${timeLabel(q.cutoff)}` : 'Not refundable (too close to the date)'],
      ['Paid to', r.provider_name],
    ] as [string, string][],
  };
}

/** Execute step: re-check space under a lock, take payment, issue the voucher. Runs in the action's transaction. */
export async function executeBooking(db: Queryable, citizenId: string, p: BookInput & { days: number }, actionId: string) {
  const r = await listingRow(db, p.listingId, true); // lock: no two bookings take the last room together
  const q = quote(r, p);
  const left = await remaining(db, r.id, r.capacity, p.startDate, q.days);
  if (left.some((d) => d.left < p.quantity)) throw conflict('sold_out', 'Someone just took the last space for those dates. Try other dates.');
  const payee = r.partner_id ? `payable:partner:${r.partner_id}` : `payable:agency:${r.agency}`;
  await ensureAccount(db, payee, 'liability', `Payable · ${r.provider_name}`);
  const ref = reference(r.kind === 'park' ? 'PP' : 'TR');
  await post(db, {
    kind: 'tourism',
    description: `${r.name} · ${ref}`,
    idempotencyKey: `action:${actionId}`,
    meta: { actionId, listingId: r.id, ref },
    lines: [
      { account: walletCode(citizenId), amount: q.total },
      { account: payee, amount: -q.total },
    ],
  });
  const c = await one<any>(db, 'SELECT first_name, last_name FROM citizens WHERE id = $1', [citizenId]);
  const b = await one<any>(
    db,
    `INSERT INTO tourism_bookings (ref, listing_id, citizen_id, start_date, days, rate_key, quantity, total, action_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [ref, r.id, citizenId, p.startDate, q.days, p.rateKey, p.quantity, q.total, actionId],
  );
  const issuer = r.partner_id ? (await one<any>(db, 'SELECT code FROM partners WHERE id = $1', [r.partner_id])).code : r.agency;
  const what = { park: 'Park permit', reserve: 'Reserve booking', stay: 'Booking', safari: 'Safari booking', driver: r.category === 'transfer' ? 'Transfer booking' : 'Driver booking' }[r.kind as Kind];
  const title = `${what} · ${r.name} · ${datesText(r, p.startDate, q.days)}${r.kind === 'stay' ? '' : ` · ${qtyText(r, p.quantity)}`}`;
  const docId = await issueDocument(
    db,
    citizenId,
    {
      type: r.kind === 'park' ? 'park_permit' : 'booking_voucher',
      title,
      issuerId: issuer,
      ref,
      validTo: new Date(slotInstant(addDays(p.startDate, q.days), '12:00')),
      data: { listingId: r.id, place: r.name, region: r.region, startDate: p.startDate, days: q.days, quantity: p.quantity, rate: q.rate.label, paid: q.total, guest: `${c.first_name} ${c.last_name}` },
    },
    `citizen:${citizenId}`,
    { notify: false },
  );
  await db.query('UPDATE tourism_bookings SET document_id = $2 WHERE id = $1', [b.id, docId]);
  await notify(db, citizenId, r.kind === 'park' ? 'Park permit issued' : 'Booking confirmed', `${r.name}, ${datesText(r, p.startDate, q.days)}. Reference ${ref}. Your ${r.kind === 'park' ? 'permit' : 'voucher'} is in your Vault.`, { sms: true });
  if (r.partner_id) {
    await enqueueEvent(db, r.partner_id, 'tourism_booking.confirmed', {
      bookingId: b.id, ref, listingId: r.id, startDate: p.startDate, days: q.days, quantity: p.quantity, rate: p.rateKey, total: q.total, currency: country().currency.code,
      guest: { name: `${c.first_name} ${c.last_name}`, subject: subjectFor(r.partner_id, citizenId) },
    });
  }
  return { message: `Booked. Reference ${ref}. Your ${r.kind === 'park' ? 'park permit' : 'voucher'} is in your Vault.`, ref, bookingId: b.id, documentId: docId };
}

function tripView(r: any) {
  const cutoff = new Date(slotInstant(r.start_date, '00:00').getTime() - r.cancel_hours * 3600_000);
  return {
    id: r.id,
    ref: r.ref,
    listing: { id: r.listing_id, name: r.name, kind: r.kind, region: r.region, provider: r.provider_name },
    startDate: r.start_date,
    days: r.days,
    when: datesText(r, r.start_date, r.days),
    quantity: r.quantity,
    quantityText: qtyText(r, r.quantity),
    rate: (r.rates as any[]).find((x) => x.key === r.rate_key)?.label ?? r.rate_key,
    total: Number(r.total),
    totalText: fmt(Number(r.total)),
    status: r.status,
    refunded: Number(r.refunded),
    freeCancelUntil: cutoff,
    canCancel: r.status === 'confirmed' && r.start_date >= localDate(),
    refundIfCancelled: r.status === 'confirmed' && Date.now() < cutoff.getTime() ? Number(r.total) : 0,
    documentId: r.document_id,
  };
}

const tripSql = `SELECT b.*, l.name, l.kind, l.region, l.rates, l.unit, l.cancel_hours, COALESCE(p.trading_name, i.name, l.agency) AS provider_name
  FROM tourism_bookings b JOIN tourism_listings l ON l.id = b.listing_id LEFT JOIN partners p ON p.id = l.partner_id LEFT JOIN issuers i ON i.id = l.agency`;

export async function myTrips(db: Queryable, citizenId: string) {
  const rows = await many<any>(db, `${tripSql} WHERE b.citizen_id = $1 ORDER BY (b.status = 'confirmed' AND b.start_date >= $2) DESC, b.start_date`, [citizenId, localDate()]);
  return rows.map(tripView);
}

/** Cancel. Full refund before the listing's cut-off; after it, only with acceptNoRefund. */
export async function cancelTrip(pool: pg.Pool, citizenId: string, id: string, acceptNoRefund = false) {
  return tx(pool, async (c) => {
    const r = await one<any>(c, `${tripSql} WHERE b.id = $1 AND b.citizen_id = $2 FOR UPDATE OF b`, [id, citizenId]);
    if (!r) throw notFound('Booking not found');
    if (r.status !== 'confirmed') throw conflict('not_active', 'This booking is already cancelled or used');
    if (r.start_date < localDate()) throw conflict('started', 'This trip has already started');
    const t = tripView(r);
    if (!t.refundIfCancelled && !acceptNoRefund) {
      throw new AppError(409, 'no_refund', `Free cancellation ended ${dayLabel(t.freeCancelUntil)}. You can still cancel, but nothing is refunded.`);
    }
    const refund = t.refundIfCancelled;
    if (refund > 0) {
      const l = await one<any>(c, 'SELECT partner_id, agency FROM tourism_listings WHERE id = $1', [r.listing_id]);
      await post(c, {
        kind: 'tourism_refund',
        description: `Refund · ${r.name} · ${r.ref}`,
        idempotencyKey: `tourism-refund:${id}`,
        meta: { bookingId: id },
        lines: [
          { account: l.partner_id ? `payable:partner:${l.partner_id}` : `payable:agency:${l.agency}`, amount: refund },
          { account: walletCode(citizenId), amount: -refund },
        ],
      });
    }
    await c.query(`UPDATE tourism_bookings SET status = 'cancelled', cancelled_at = now(), refunded = $2 WHERE id = $1`, [id, refund]);
    if (r.document_id) await c.query(`UPDATE documents SET status = 'revoked' WHERE id = $1`, [r.document_id]);
    await audit(c, `citizen:${citizenId}`, 'tourism.cancelled', `tourism_booking:${id}`, { refund });
    await notify(c, citizenId, 'Booking cancelled', `${r.name} · ${r.ref}. ${refund ? `${fmt(refund)} is back in your wallet.` : 'No refund was due.'}`, { sms: false });
    const listing = await one<any>(c, 'SELECT partner_id FROM tourism_listings WHERE id = $1', [r.listing_id]);
    if (listing.partner_id) await enqueueEvent(c, listing.partner_id, 'tourism_booking.cancelled', { bookingId: id, ref: r.ref, refund, subject: subjectFor(listing.partner_id, citizenId) });
    return { id, status: 'cancelled', refunded: refund, refundedText: fmt(refund) };
  });
}

// ---------------------------------------------------------------------------
// Hotels and tour operators (partner API)
// ---------------------------------------------------------------------------

const rateSchema = z.object({ key: z.string().regex(/^[a-z0-9_-]{1,30}$/), label: z.string().trim().min(2).max(60), price: z.union([z.string(), z.number()]) });
export const listingSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9-]{2,30}$/, 'Use 2 to 30 lowercase letters, digits or dashes'),
  name: z.string().trim().min(3).max(80),
  region: z.string().trim().min(2).max(60),
  description: z.string().trim().min(10).max(600),
  highlights: z.array(z.string().trim().min(2).max(60)).max(6).default([]),
  rates: z.array(rateSchema).min(1).max(6),
  capacity: z.number().int().min(1).max(500),
  durationDays: z.number().int().min(1).max(30).default(1),
  cancelHours: z.number().int().min(0).max(720).default(48),
  active: z.boolean().default(true),
  /** Stays: lodge, hotel, camp or guesthouse. Drivers: transfer or driver_guide. */
  category: z.string().max(20).optional(),
  /** Game reserves: person_day (entry) or person (a drive). Drivers: vehicle_day or trip. */
  unit: z.enum(['person_day', 'person', 'vehicle_day', 'trip']).optional(),
});

export async function upsertListing(db: Queryable, partnerId: string, l: z.infer<typeof listingSchema>) {
  const p = await one<any>(db, 'SELECT code, type, status, capabilities FROM partners WHERE id = $1', [partnerId]);
  if (!p || p.status !== 'approved') throw forbidden('Your partner account is not active');
  if (!(p.capabilities as string[]).includes(LISTINGS_MANAGE)) throw forbidden('Your approval does not include tourism listings');
  const kind: Kind = ({ hotel: 'stay', tour_operator: 'safari', game_reserve: 'reserve', transport: 'driver' } as Record<string, Kind>)[p.type] ?? 'safari';
  const unit = kind === 'stay' ? 'room_night' : kind === 'safari' ? 'person'
    : kind === 'reserve' ? (l.unit === 'person' ? 'person' : 'person_day')
    : l.unit === 'trip' ? 'trip' : 'vehicle_day';
  if (l.category && !(CATEGORIES[kind] ?? []).includes(l.category)) throw badRequest('invalid_category', `Category for this listing: ${(CATEGORIES[kind] ?? []).join(', ') || 'none'}`);
  const { toThebe } = await import('../lib/money.js');
  const rates = l.rates.map((r) => ({ key: r.key, label: r.label, price: toThebe(r.price) }));
  if (rates.some((r) => r.price <= 0)) throw badRequest('invalid_price', 'Every rate needs a price above zero');
  const id = `${p.code}-${l.key}`;
  const owner = await one<any>(db, 'SELECT partner_id FROM tourism_listings WHERE id = $1', [id]);
  if (owner && owner.partner_id !== partnerId) throw conflict('taken', 'That listing id belongs to someone else');
  await db.query(
    `INSERT INTO tourism_listings (id, kind, name, region, description, highlights, unit, rates, capacity, duration_days, cancel_hours, partner_id, active, category)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, region = EXCLUDED.region, description = EXCLUDED.description, highlights = EXCLUDED.highlights, unit = EXCLUDED.unit,
       rates = EXCLUDED.rates, capacity = EXCLUDED.capacity, duration_days = EXCLUDED.duration_days, cancel_hours = EXCLUDED.cancel_hours, active = EXCLUDED.active, category = EXCLUDED.category`,
    [id, kind, l.name, l.region, l.description, l.highlights, unit, JSON.stringify(rates), l.capacity, kind === 'safari' ? l.durationDays : 1, l.cancelHours, partnerId, l.active, l.category ?? (kind === 'stay' ? 'lodge' : null)],
  );
  await audit(db, `partner:${partnerId}`, 'tourism.listing_saved', `listing:${id}`, { kind, active: l.active });
  return view(await one<any>(db, `${listingSql} WHERE l.id = $1`, [id]));
}

export async function partnerListings(db: Queryable, partnerId: string) {
  return (await many<any>(db, `${listingSql} WHERE l.partner_id = $1 ORDER BY l.name`, [partnerId])).map((r) => ({ ...view(r), active: r.active }));
}

export async function partnerTourismBookings(db: Queryable, partnerId: string, from?: string, days = 30) {
  const start = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : localDate();
  const rows = await many<any>(
    db,
    `${tripSql.replace('SELECT b.*', 'SELECT b.*, c.first_name, c.last_name')} JOIN citizens c ON c.id = b.citizen_id
      WHERE l.partner_id = $1 AND b.start_date >= $2 AND b.start_date < $2::date + $3::int ORDER BY b.start_date, b.created_at`,
    [partnerId, start, days],
  );
  return rows.map((r) => ({
    id: r.id, ref: r.ref, listingId: r.listing_id, listing: r.name, startDate: r.start_date, days: r.days, quantity: r.quantity,
    rate: (r.rates as any[]).find((x) => x.key === r.rate_key)?.label ?? r.rate_key, total: Number(r.total), totalText: fmt(Number(r.total)), status: r.status,
    guest: { name: `${r.first_name} ${r.last_name}`, subject: subjectFor(partnerId, r.citizen_id) },
  }));
}

// ---------------------------------------------------------------------------
// Park gates (parks agency officers)
// ---------------------------------------------------------------------------

export async function gatePermits(db: Queryable, agency: string, date?: string) {
  const d = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localDate();
  const rows = await many<any>(
    db,
    `${tripSql.replace('SELECT b.*', 'SELECT b.*, c.first_name, c.last_name, c.omang_last4')} JOIN citizens c ON c.id = b.citizen_id
      WHERE l.agency = $1 AND l.kind = 'park' AND b.status IN ('confirmed','completed') AND $2::date >= b.start_date AND $2::date < b.start_date + b.days
      ORDER BY l.name, c.last_name`,
    [agency, d],
  );
  return {
    date: d,
    permits: rows.map((r) => ({
      id: r.id, ref: r.ref, park: r.name, holder: `${r.first_name} ${r.last_name}`, idLast4: r.omang_last4, people: r.quantity,
      rate: (r.rates as any[]).find((x) => x.key === r.rate_key)?.label ?? r.rate_key, when: datesText(r, r.start_date, r.days), status: r.status,
    })),
  };
}

export async function gateCheckIn(db: Queryable, agency: string, bookingId: string, officerId: string) {
  const r = await one<any>(
    db,
    `UPDATE tourism_bookings b SET status = 'completed' FROM tourism_listings l
      WHERE b.id = $1 AND l.id = b.listing_id AND l.agency = $2 AND b.status = 'confirmed' RETURNING b.ref`,
    [bookingId, agency],
  );
  if (!r) throw notFound('No valid permit with that id for your parks');
  await audit(db, `officer:${officerId}`, 'tourism.checked_in', `tourism_booking:${bookingId}`);
  return { id: bookingId, ref: r.ref, status: 'completed' };
}

// ---------------------------------------------------------------------------
// Reference and demo data
// ---------------------------------------------------------------------------

/** The parks agency issues park permits into the Vault. Every cell. */
export async function seedTourismReference(db: Queryable) {
  const t = COUNTRY_TOURISM[country().code];
  await db.query('INSERT INTO issuers (id, name, api_key_hash) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name', [t.parksAgency.code, t.parksAgency.name, 'agency']);
  await ensureAccount(db, `payable:agency:${t.parksAgency.code}`, 'liability', `Fees payable · ${t.parksAgency.code}`);
  await seedParks(db);
}

async function insertSeed(db: Queryable, l: ListingSeed, id: string, owner: { partnerId?: string; agency?: string }, active = true) {
  await db.query(
    `INSERT INTO tourism_listings (id, kind, name, region, description, highlights, unit, rates, capacity, duration_days, cancel_hours, partner_id, agency, category, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO NOTHING`,
    [id, l.kind, l.name, l.region, l.description, l.highlights, l.unit, JSON.stringify(l.rates), l.capacity, l.durationDays ?? 1, l.cancelHours, owner.partnerId ?? null, owner.agency ?? null, l.category ?? null, active],
  );
}

/**
 * Parks are created in every cell. In a live cell they start hidden: the parks
 * agency (or a Kgotla admin) enters the real fees and switches each park on.
 */
export async function seedParks(db: Queryable) {
  const t = COUNTRY_TOURISM[country().code];
  for (const p of t.parks) await insertSeed(db, p, `park-${p.key}`, { agency: t.parksAgency.code }, config.demoMode);
}

export const parkSchema = z.object({
  active: z.boolean(),
  capacity: z.number().int().min(1).max(5000).optional(),
  cancelHours: z.number().int().min(0).max(720).optional(),
  rates: z.array(z.object({ key: z.string().min(1).max(30), price: z.union([z.string(), z.number()]) })).optional(),
});

export async function listParks(db: Queryable) {
  return (await many<any>(db, `${listingSql} WHERE l.kind = 'park' AND l.agency = $1 ORDER BY l.name`, [parksAgency().code])).map((r) => ({ ...view(r), active: r.active }));
}

/** The parks agency sets real fees and opens a park for booking. */
export async function updatePark(db: Queryable, officerId: string, id: string, u: z.infer<typeof parkSchema>) {
  const r = await one<any>(db, `SELECT * FROM tourism_listings WHERE id = $1 AND kind = 'park' AND agency = $2 FOR UPDATE`, [id, parksAgency().code]);
  if (!r) throw notFound('Park not found');
  const { toThebe } = await import('../lib/money.js');
  const rates = (r.rates as any[]).map((x) => {
    const n = u.rates?.find((y) => y.key === x.key);
    return n ? { ...x, price: toThebe(n.price) } : x;
  });
  if (rates.some((x) => !(x.price > 0))) throw badRequest('invalid_price', 'Every fee must be above zero');
  await db.query('UPDATE tourism_listings SET active = $2, rates = $3, capacity = COALESCE($4, capacity), cancel_hours = COALESCE($5, cancel_hours) WHERE id = $1', [id, u.active, JSON.stringify(rates), u.capacity ?? null, u.cancelHours ?? null]);
  await audit(db, `officer:${officerId}`, 'tourism.park_updated', `listing:${id}`, { active: u.active, rates: rates.map((x) => [x.key, x.price]) });
  return { ...view(await one<any>(db, `${listingSql} WHERE l.id = $1`, [id])), active: u.active };
}

/** Demo cells: parks with demo fees, the demo hotel's and tour operator's listings, and a gate officer. */
export async function seedTourismDemo(db: Queryable, password: string, log: (m: string) => void) {
  const t = COUNTRY_TOURISM[country().code];
  for (const [code, list] of Object.entries(t.demoListings)) {
    const p = await one<any>(db, 'SELECT id FROM partners WHERE code = $1', [code]);
    if (!p) continue;
    for (const l of list) await insertSeed(db, l, `${code}-${l.key}`, { partnerId: p.id });
  }
  if (!(await one(db, `SELECT 1 FROM officers WHERE username = 'parks.gate'`))) {
    await db.query(`INSERT INTO officers (username, name, agency, role, password_hash) VALUES ('parks.gate', $1, $2, 'counter', $3)`, [`Gate officer · ${t.parksAgency.code}`, t.parksAgency.code, await hashSecret(password)]);
    log(`demo officer parks.gate (${t.parksAgency.code} gate)${config.demoMode && !process.env.DEMO_OFFICER_PASSWORD ? ` · password ${password}` : ''}`);
  }
}

export const parksAgency = () => COUNTRY_TOURISM[country().code].parksAgency;
