import type { Queryable } from '../db.js';
import { many, one } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { enqueue, notify } from '../lib/notify.js';
import { dayLabel, localDate, nextWorkdays, slotInstant, timeLabel } from '../lib/time.js';

// ---------------------------------------------------------------------------
// Bookings (clinics, passport offices, eye-test rooms)
// ---------------------------------------------------------------------------

export async function locations(db: Queryable, kind?: string) {
  return many<any>(
    db,
    `SELECT id, kind, name, agency, capacity, slot_times, services, counter_count FROM locations ${kind ? 'WHERE kind = $1' : ''} ORDER BY kind, name`,
    kind ? [kind] : [],
  );
}

/** Free slots over the next n working days for one location. */
export async function availability(db: Queryable, locationId: string, days = 5) {
  const loc = await one<any>(db, 'SELECT id, name, kind, capacity, slot_times FROM locations WHERE id = $1', [locationId]);
  if (!loc) throw notFound('Unknown location');
  const dates = nextWorkdays(days);
  const from = slotInstant(dates[0], '00:00');
  const to = slotInstant(dates[dates.length - 1], '23:59');
  const taken = await many<{ starts_at: Date; n: number }>(
    db,
    `SELECT starts_at, count(*)::int AS n FROM appointments
      WHERE location_id = $1 AND status = 'booked' AND starts_at BETWEEN $2 AND $3 GROUP BY starts_at`,
    [locationId, from, to],
  );
  const used = new Map(taken.map((t) => [new Date(t.starts_at).toISOString(), t.n]));
  return {
    location: { id: loc.id, name: loc.name, kind: loc.kind },
    days: dates.map((date) => ({
      date,
      label: dayLabel(date),
      slots: (loc.slot_times as string[]).map((time) => {
        const at = slotInstant(date, time);
        const left = loc.capacity - (used.get(at.toISOString()) ?? 0);
        return { time, startsAt: at.toISOString(), available: left > 0 };
      }),
    })),
  };
}

/** Book a slot, respecting capacity. Runs in the caller's transaction. */
export async function book(db: Queryable, citizenId: string, locationId: string, startsAt: string, purpose: string, applicationId?: string) {
  const loc = await one<any>(db, 'SELECT id, name, capacity, slot_times FROM locations WHERE id = $1 FOR UPDATE', [locationId]);
  if (!loc) throw notFound('Unknown location');
  const at = new Date(startsAt);
  if (isNaN(at.getTime()) || at.getTime() < Date.now()) throw badRequest('invalid_slot', 'Choose a time in the future');
  if (!(loc.slot_times as string[]).includes(timeLabel(at))) throw badRequest('invalid_slot', 'That time is not a bookable slot here');
  const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM appointments WHERE location_id = $1 AND starts_at = $2 AND status = 'booked'`, [locationId, at]);
  if ((n?.n ?? 0) >= loc.capacity) throw conflict('slot_full', 'That slot was just taken. Choose another time.');
  try {
    const r = await one<any>(
      db,
      'INSERT INTO appointments (citizen_id, location_id, starts_at, purpose, application_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [citizenId, locationId, at, purpose, applicationId ?? null],
    );
    await notify(db, citizenId, 'Appointment booked', `${loc.name}, ${dayLabel(at)} at ${timeLabel(at)}.`, { sms: true });
    await audit(db, `citizen:${citizenId}`, 'appointment.booked', `appointment:${r.id}`, { locationId, startsAt: at.toISOString() });
    return { id: r.id as string, where: loc.name as string, startsAt: at };
  } catch (e: any) {
    if (e?.code === '23505') throw conflict('double_booking', 'You already have an appointment at that time');
    throw e;
  }
}

export async function myAppointments(db: Queryable, citizenId: string) {
  return many<any>(
    db,
    `SELECT a.id, a.starts_at, a.purpose, a.status, l.name AS where, l.kind
       FROM appointments a JOIN locations l ON l.id = a.location_id
      WHERE a.citizen_id = $1 AND a.status = 'booked' AND a.starts_at > now() - interval '2 hours'
      ORDER BY a.starts_at`,
    [citizenId],
  );
}

export async function cancelAppointment(db: Queryable, citizenId: string, id: string) {
  const r = await db.query(`UPDATE appointments SET status = 'cancelled' WHERE id = $1 AND citizen_id = $2 AND status = 'booked'`, [id, citizenId]);
  if (!r.rowCount) throw notFound('Appointment not found');
  await audit(db, `citizen:${citizenId}`, 'appointment.cancelled', `appointment:${id}`);
}

// ---------------------------------------------------------------------------
// Smart queue
// ---------------------------------------------------------------------------

const NEAR = 3; // notify when this many people are ahead

export async function queueOffices(db: Queryable) {
  const today = localDate();
  return many<any>(
    db,
    `SELECT l.id, l.name, l.services, l.counter_count,
            (SELECT count(*)::int FROM queue_tickets q WHERE q.location_id = l.id AND q.day = $1 AND q.status = 'waiting') AS waiting
       FROM locations l WHERE l.kind = 'office' ORDER BY l.name`,
    [today],
  );
}

/** Take a ticket. Identified citizen, or a bare phone number (USSD, unregistered). */
export async function takeTicket(db: Queryable, who: { citizenId?: string; phone?: string }, locationId: string, service: string) {
  const loc = await one<any>(db, `SELECT id, name, services FROM locations WHERE id = $1 AND kind = 'office'`, [locationId]);
  if (!loc) throw notFound('Unknown office');
  const services = loc.services as string[];
  if (!services.includes(service)) throw badRequest('invalid_service', `Choose one of: ${services.join(', ')}`);
  const today = localDate();
  if (who.citizenId) {
    const existing = await one<any>(db, `SELECT label FROM queue_tickets WHERE citizen_id = $1 AND day = $2 AND status IN ('waiting','called')`, [who.citizenId, today]);
    if (existing) throw conflict('already_queued', `You already have ticket ${existing.label} today`);
  }
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`queue:${locationId}:${today}:${service}`]);
  const seq = (await one<{ s: number }>(db, 'SELECT COALESCE(max(seq),0)+1 AS s FROM queue_tickets WHERE location_id = $1 AND day = $2 AND service = $3', [locationId, today, service]))!.s;
  const label = `${String.fromCharCode(65 + services.indexOf(service))}-${String(seq).padStart(3, '0')}`;
  const t = await one<any>(
    db,
    `INSERT INTO queue_tickets (location_id, service, day, seq, label, citizen_id, phone) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
    [locationId, service, today, seq, label, who.citizenId ?? null, who.phone ?? null],
  );
  const ahead = await peopleAhead(db, t.id);
  if (who.citizenId) await notify(db, who.citizenId, `Queue ticket ${label}`, `${loc.name} · ${ahead} ahead of you.`, { sms: false });
  return { id: t.id as string, label, office: loc.name as string, service, ahead };
}

export async function peopleAhead(db: Queryable, ticketId: string): Promise<number> {
  const r = await one<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM queue_tickets q, queue_tickets me
      WHERE me.id = $1 AND q.location_id = me.location_id AND q.day = me.day
        AND q.status = 'waiting' AND q.created_at < me.created_at`,
    [ticketId],
  );
  return r?.n ?? 0;
}

export async function myTicket(db: Queryable, citizenId: string) {
  const t = await one<any>(
    db,
    `SELECT q.id, q.label, q.service, q.status, q.counter, l.name AS office
       FROM queue_tickets q JOIN locations l ON l.id = q.location_id
      WHERE q.citizen_id = $1 AND q.day = $2 AND q.status IN ('waiting','called')
      ORDER BY q.created_at DESC LIMIT 1`,
    [citizenId, localDate()],
  );
  if (!t) return null;
  return { ...t, ahead: t.status === 'waiting' ? await peopleAhead(db, t.id) : 0 };
}

export async function leaveQueue(db: Queryable, citizenId: string) {
  await db.query(`UPDATE queue_tickets SET status = 'left' WHERE citizen_id = $1 AND day = $2 AND status = 'waiting'`, [citizenId, localDate()]);
}

/**
 * A counter calls the next person. Marks the counter's previous ticket served,
 * calls the oldest waiting ticket, tells that person where to go, and warns
 * whoever is now NEAR places away.
 */
export async function callNext(db: Queryable, locationId: string, counter: number, actor: string) {
  const today = localDate();
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`queue-call:${locationId}:${today}`]);
  await db.query(`UPDATE queue_tickets SET status = 'served' WHERE location_id = $1 AND day = $2 AND status = 'called' AND counter = $3`, [locationId, today, counter]);
  const next = await one<any>(
    db,
    `SELECT id, label, citizen_id, phone FROM queue_tickets WHERE location_id = $1 AND day = $2 AND status = 'waiting'
      ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [locationId, today],
  );
  if (!next) return null;
  await db.query(`UPDATE queue_tickets SET status = 'called', counter = $2, called_at = now() WHERE id = $1`, [next.id, counter]);
  const msg = `Ticket ${next.label}: please go to counter ${counter} now.`;
  if (next.citizen_id) await notify(db, next.citizen_id, 'It is your turn', msg, { sms: true });
  else if (next.phone) await enqueue(db, 'sms.phone', { phone: next.phone, text: msg });

  const near = await many<any>(
    db,
    `SELECT id, label, citizen_id, phone FROM queue_tickets
      WHERE location_id = $1 AND day = $2 AND status = 'waiting' AND NOT near_notified
      ORDER BY created_at OFFSET $3 LIMIT 1`,
    [locationId, today, NEAR],
  );
  for (const n of near) {
    await db.query('UPDATE queue_tickets SET near_notified = true WHERE id = $1', [n.id]);
    const text = `Ticket ${n.label}: ${NEAR} people ahead of you. Head to the office now.`;
    if (n.citizen_id) await notify(db, n.citizen_id, 'Almost your turn', text, { sms: true });
    else if (n.phone) await enqueue(db, 'sms.phone', { phone: n.phone, text });
  }
  await audit(db, actor, 'queue.called', `ticket:${next.id}`, { counter, label: next.label });
  return { id: next.id as string, label: next.label as string, counter };
}

export async function queueBoard(db: Queryable, locationId: string) {
  const today = localDate();
  return many<any>(
    db,
    `SELECT id, label, service, status, counter, created_at, called_at FROM queue_tickets
      WHERE location_id = $1 AND day = $2 AND status IN ('waiting','called') ORDER BY created_at`,
    [locationId, today],
  );
}
