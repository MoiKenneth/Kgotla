import type pg from 'pg';
import type { Queryable } from '../db.js';
import { many } from '../db.js';

/**
 * Write an in-app notification and, when asked, queue an SMS through the
 * transactional outbox. Both rows commit or roll back with the caller's
 * transaction, so a citizen is never told about something that didn't happen.
 */
export async function notify(
  db: Queryable,
  citizenId: string,
  title: string,
  body: string,
  opts: { sms?: boolean } = {},
): Promise<void> {
  await db.query('INSERT INTO notifications (citizen_id, title, body) VALUES ($1,$2,$3)', [citizenId, title, body]);
  if (opts.sms) await enqueue(db, 'sms.citizen', { citizenId, text: `${title}: ${body}` });
}

export async function enqueue(db: Queryable, topic: string, payload: Record<string, unknown>): Promise<void> {
  await db.query('INSERT INTO outbox (topic, payload) VALUES ($1,$2)', [topic, JSON.stringify(payload)]);
}

/** Pluggable SMS gateway. Production: Africa's Talking, Orange or Mascom bulk SMS APIs. */
export interface SmsGateway {
  send(to: string, text: string): Promise<void>;
}

/** Development gateway: keeps messages in memory and logs them. */
export class MemorySms implements SmsGateway {
  sent: { to: string; text: string; at: Date }[] = [];
  constructor(private log?: (m: string) => void) {}
  async send(to: string, text: string) {
    this.sent.push({ to, text, at: new Date() });
    this.log?.(`[sms] to ${to}: ${text}`);
  }
}

/**
 * Twilio Programmable Messaging. Works for numbers in all five countries.
 * Swap for a local aggregator (for example Africa's Talking, or an operator's
 * bulk SMS API) by implementing SmsGateway the same way.
 */
export class TwilioSms implements SmsGateway {
  constructor(
    private opts: { accountSid: string; authToken: string; from?: string; messagingServiceSid?: string },
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async send(to: string, text: string) {
    const form = new URLSearchParams({ To: to, Body: text });
    if (this.opts.messagingServiceSid) form.set('MessagingServiceSid', this.opts.messagingServiceSid);
    else form.set('From', this.opts.from ?? '');
    const r = await this.fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.opts.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(`${this.opts.accountSid}:${this.opts.authToken}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      const j: any = await r.json().catch(() => ({}));
      throw new Error(`Twilio ${r.status}${j.code ? ` ${j.code}` : ''}: ${j.message ?? 'send failed'}`);
    }
  }
}

/** Deliver pending outbox rows. Safe to run from several workers (SKIP LOCKED). */
export async function processOutbox(pool: pg.Pool, sms: SmsGateway, batch = 50): Promise<number> {
  const c = await pool.connect();
  let done = 0;
  try {
    await c.query('BEGIN');
    const rows = await many<any>(
      c,
      `SELECT id, topic, payload FROM outbox WHERE processed_at IS NULL AND attempts < 8
       ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batch],
    );
    for (const r of rows) {
      try {
        if (r.topic === 'sms.citizen') {
          const p = await c.query('SELECT phone FROM citizens WHERE id = $1', [r.payload.citizenId]);
          if (p.rows[0]) await sms.send(p.rows[0].phone, r.payload.text);
        } else if (r.topic === 'sms.phone') {
          await sms.send(r.payload.phone, r.payload.text);
        }
        await c.query('UPDATE outbox SET processed_at = now(), attempts = attempts + 1 WHERE id = $1', [r.id]);
        done++;
      } catch (e) {
        await c.query('UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1', [r.id, String(e)]);
      }
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  return done;
}
