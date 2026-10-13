import type pg from 'pg';
import { config } from '../config.js';
import type { Queryable } from '../db.js';
import { many, one } from '../db.js';
import { timingSafeEqual } from 'node:crypto';
import { hmac, randomToken } from './crypto.js';
import { badRequest } from './errors.js';

/**
 * Signed event notifications to partners.
 *
 * Events are written to webhook_deliveries in the same transaction as the
 * change they describe (so a partner is never told about something that was
 * rolled back), then a worker POSTs them with retries.
 *
 * Every request carries:
 *   Kgotla-Event:      consent.granted, payment_request.paid, ...
 *   Kgotla-Delivery:   delivery id (retries reuse it; use it to de-duplicate)
 *   Kgotla-Signature:  t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 */

export const WEBHOOK_EVENTS = [
  'consent.granted',
  'consent.declined',
  'consent.revoked',
  'payment_request.paid',
  'payment_request.declined',
  'appointment.booked',
  'appointment.cancelled',
  'tourism_booking.confirmed',
  'tourism_booking.cancelled',
  'partner.approved',
  'partner.suspended',
  'ping',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Seconds to wait after each failed attempt. After the last one the delivery is marked failed. */
const BACKOFF = [30, 120, 600, 3600, 6 * 3600, 24 * 3600];
export const MAX_ATTEMPTS = BACKOFF.length + 1;

/** Per-partner signing secret, derived from KGOTLA_SECRET so nothing extra is stored. Rotating bumps the version. */
export const webhookSecret = (partnerId: string, version: number) => 'whsec_' + hmac(`webhook:${partnerId}:${version}`).slice(0, 48);

export function sign(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${hmac(`${timestamp}.${body}`, secret)}`;
}

/** Check a Kgotla-Signature header. Partners do the same check on their side (docs/PARTNERS.md). */
export function verifySignature(secret: string, header: string, body: string, toleranceSec = 300, now = Date.now()): boolean {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || !parts.v1 || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const want = Buffer.from(hmac(`${t}.${body}`, secret));
  const got = Buffer.from(parts.v1);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Pairwise pseudonymous id: the same citizen has a different id at every partner. */
export const subjectFor = (partnerId: string, citizenId: string) => 'sub_' + hmac(`subject:${partnerId}:${citizenId}`).slice(0, 24);

/** Queue an event for a partner (no-op when it has no webhook URL). Runs in the caller's transaction. */
export async function enqueueEvent(db: Queryable, partnerId: string, event: WebhookEvent, data: Record<string, unknown>): Promise<void> {
  const p = await one<{ webhook_url: string | null }>(db, 'SELECT webhook_url FROM partners WHERE id = $1', [partnerId]);
  if (!p?.webhook_url) return;
  const payload = { id: 'evt_' + randomToken(12), type: event, created: new Date().toISOString(), data };
  await db.query('INSERT INTO webhook_deliveries (partner_id, event, payload) VALUES ($1,$2,$3)', [partnerId, event, JSON.stringify(payload)]);
}

/** Reject URLs that point back into private networks once a cell is hosted (basic SSRF guard). */
export function checkWebhookUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest('invalid_webhook_url', 'Enter a full URL, for example https://api.example.com/kgotla/events');
  }
  const hosted = config.production || config.cloud;
  if (u.protocol !== 'https:' && (hosted || u.protocol !== 'http:')) throw badRequest('invalid_webhook_url', 'The webhook URL must use https');
  if (hosted) {
    const h = u.hostname;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd])/i.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.internal')) {
      throw badRequest('invalid_webhook_url', 'The webhook URL must be reachable on the public internet');
    }
  }
  return u.toString();
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; ok: boolean }>;

/**
 * Deliver due webhooks. Claims a batch by pushing next_attempt_at forward (a
 * lease), commits, then makes the HTTP calls outside any transaction. Safe
 * with several workers. Returns how many were delivered.
 */
export async function processWebhooks(pool: pg.Pool, fetchImpl: FetchLike = fetch as unknown as FetchLike, batch = 20): Promise<number> {
  const claimed = await many<any>(
    pool,
    `UPDATE webhook_deliveries d SET next_attempt_at = now() + interval '5 minutes'
      WHERE d.id IN (SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= now()
                     ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING d.id, d.partner_id, d.event, d.payload, d.attempts`,
    [batch],
  );
  let delivered = 0;
  for (const d of claimed) {
    const p = await one<any>(pool, 'SELECT webhook_url, webhook_secret_version, status FROM partners WHERE id = $1', [d.partner_id]);
    const attempts = d.attempts + 1;
    if (!p?.webhook_url || p.status !== 'approved') {
      await pool.query(`UPDATE webhook_deliveries SET status = 'failed', attempts = $2, last_error = 'partner has no webhook URL or is not active' WHERE id = $1`, [d.id, attempts]);
      continue;
    }
    const body = JSON.stringify(d.payload);
    const ts = Math.floor(Date.now() / 1000);
    let status: number | null = null;
    let error: string | null = null;
    try {
      const r = await fetchImpl(p.webhook_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Kgotla-Webhooks/1',
          'kgotla-event': d.event,
          'kgotla-delivery': String(d.id),
          'kgotla-signature': sign(webhookSecret(d.partner_id, p.webhook_secret_version), ts, body),
        },
        body,
        signal: AbortSignal.timeout(8000),
      });
      status = r.status;
      if (!r.ok) error = `HTTP ${r.status}`;
    } catch (e: any) {
      error = String(e?.message ?? e).slice(0, 300);
    }
    if (!error) {
      await pool.query(`UPDATE webhook_deliveries SET status = 'delivered', attempts = $2, last_status = $3, last_error = NULL, delivered_at = now() WHERE id = $1`, [d.id, attempts, status]);
      delivered++;
    } else if (attempts >= MAX_ATTEMPTS) {
      await pool.query(`UPDATE webhook_deliveries SET status = 'failed', attempts = $2, last_status = $3, last_error = $4 WHERE id = $1`, [d.id, attempts, status, error]);
    } else {
      await pool.query(
        `UPDATE webhook_deliveries SET attempts = $2, last_status = $3, last_error = $4, next_attempt_at = now() + make_interval(secs => $5) WHERE id = $1`,
        [d.id, attempts, status, error, BACKOFF[attempts - 1]],
      );
    }
  }
  return delivered;
}
