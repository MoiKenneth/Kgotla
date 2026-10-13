import { randomInt } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { config } from '../config.js';
import { biller as packBiller, country, networks, payableBillers } from '../countries/index.js';
import { many, one, tx, type Queryable } from '../db.js';
import { audit } from '../lib/audit.js';
import { verifyPin } from '../lib/auth.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { fmt, toThebe } from '../lib/money.js';
import { notify } from '../lib/notify.js';
import { dayLabel, timeLabel } from '../lib/time.js';
import { getTemplate, openApplication } from './gov.js';
import { maskPhone, normalisePhone, type Registry } from './identity.js';
import { ensureAccount, post, walletBalance, walletCode } from './ledger.js';
import { book, takeTicket } from './places.js';

/**
 * Confirmable actions.
 *
 * Every operation that moves money, submits an application or books on a
 * citizen's behalf is created first as a PENDING action with a plain-language
 * read-back ("Send P 200.00 to Mpho K."). Nothing happens until the citizen
 * confirms it — with their PIN for anything that costs money — and an action
 * executes at most once. The app, USSD and the AI assistant all use this same
 * path, so the assistant can prepare but never perform.
 */

export type Source = 'app' | 'assistant' | 'ussd';

/** A vendor that sells prepaid electricity tokens / airtime. Production: the utility's and operators' vending APIs. */
export interface Vending {
  electricityToken(meter: string, thebe: number): Promise<string>;
  airtime(network: string, phone: string, thebe: number): Promise<void>;
}
export class MockVending implements Vending {
  async electricityToken() {
    return Array.from({ length: 5 }, () => String(randomInt(0, 10000)).padStart(4, '0')).join(' ');
  }
  async airtime() {}
}

export interface ActionCtx {
  registry: Registry;
  vending: Vending;
}

interface Prepared {
  params: Record<string, unknown>;
  label: string;
  readback: [string, string][];
  amount: number;
}

interface Def<P> {
  requiresPin: boolean;
  schema: z.ZodType<P>;
  prepare(db: Queryable, ctx: ActionCtx, citizenId: string, p: P): Promise<Prepared>;
  execute(db: Queryable, ctx: ActionCtx, citizenId: string, p: any, actionId: string): Promise<{ message: string; [k: string]: unknown }>;
}

const amount = z.union([z.string(), z.number()]).transform((v) => toThebe(v));
/** A string that must be one of this cell's ids (billers, networks, sources). */
const oneOf = (ids: () => string[], what: string) =>
  z.string().refine((v) => ids().includes(v), (v) => ({ message: `Unknown ${what} "${v}". Choose one of: ${ids().join(', ')}` }));

async function requireFunds(db: Queryable, citizenId: string, thebe: number) {
  const b = await walletBalance(db, citizenId);
  if (b < thebe) throw conflict('insufficient_funds', `Your wallet has ${fmt(b)}. You need ${fmt(thebe)}. Top up first.`);
}

const sourceName = (id: string) => country().topUpSources.find((s) => s.id === id)?.name ?? id;

async function citizenName(db: Queryable, id: string) {
  const c = await one<any>(db, 'SELECT first_name, last_name, phone FROM citizens WHERE id = $1', [id]);
  return c;
}

const defs: Record<string, Def<any>> = {
  send_money: {
    requiresPin: true,
    schema: z.object({ to: z.string().min(3), amount }),
    async prepare(db, _ctx, citizenId, p) {
      let rec: any = null;
      if (/^[0-9a-f-]{36}$/i.test(p.to)) rec = await one<any>(db, 'SELECT id, first_name, last_name, phone FROM citizens WHERE id = $1', [p.to]);
      else rec = await one<any>(db, 'SELECT id, first_name, last_name, phone FROM citizens WHERE phone = $1', [normalisePhone(p.to)]);
      if (!rec) throw notFound('No Kgotla wallet uses that number. Ask them to register, or check the number.');
      if (rec.id === citizenId) throw badRequest('self_transfer', 'You cannot send money to yourself');
      if (p.amount > country().limits.transferMax) throw badRequest('limit', `The limit for one transfer is ${fmt(country().limits.transferMax)}`);
      await requireFunds(db, citizenId, p.amount);
      const to = `${rec.first_name} ${rec.last_name[0]}.`;
      return {
        params: { toCitizenId: rec.id, amount: p.amount },
        label: `Send ${fmt(p.amount)} to ${to}`,
        amount: p.amount,
        readback: [['To', to], ['Number', maskPhone(rec.phone)], ['Amount', fmt(p.amount)], ['Fee', fmt(0)]],
      };
    },
    async execute(db, _ctx, citizenId, p, actionId) {
      const from = await citizenName(db, citizenId);
      const to = await citizenName(db, p.toCitizenId);
      await post(db, {
        kind: 'p2p',
        description: `Sent to ${to.first_name} ${to.last_name}`,
        idempotencyKey: `action:${actionId}`,
        meta: { actionId, to: p.toCitizenId },
        lines: [
          { account: walletCode(citizenId), amount: p.amount },
          { account: walletCode(p.toCitizenId), amount: -p.amount },
        ],
      });
      await notify(db, p.toCitizenId, 'Money received', `${fmt(p.amount)} from ${from.first_name} ${from.last_name}.`, { sms: true });
      return { message: `Sent ${fmt(p.amount)} to ${to.first_name} ${to.last_name}.` };
    },
  },

  pay_bill: {
    requiresPin: true,
    schema: z.object({ biller: oneOf(() => payableBillers().map((b) => b.id), 'biller'), ref: z.string().min(1), amount }),
    async prepare(db, _ctx, citizenId, p) {
      const b = await one<any>(db, 'SELECT id, name, ref_label, ref_pattern FROM billers WHERE id = $1', [p.biller]);
      if (!b) throw notFound('Unknown biller');
      const ref = p.ref.replace(/\s+/g, '');
      if (!new RegExp(b.ref_pattern).test(ref)) throw badRequest('invalid_reference', `Check the ${b.ref_label.toLowerCase()}`);
      if (p.amount < country().limits.billMin) throw badRequest('minimum', `The minimum payment is ${fmt(country().limits.billMin)}`);
      await requireFunds(db, citizenId, p.amount);
      return {
        params: { biller: b.id, ref, amount: p.amount },
        label: `Pay ${fmt(p.amount)} to ${packBiller(b.id)?.short ?? b.name}`,
        amount: p.amount,
        readback: [['To', b.name], [b.ref_label, ref], ['Amount', fmt(p.amount)], ['Fee', fmt(0)]],
      };
    },
    async execute(db, ctx, citizenId, p, actionId) {
      const b = await one<any>(db, 'SELECT id, name FROM billers WHERE id = $1', [p.biller]);
      await ensureAccount(db, `payable:biller:${b.id}`, 'liability', `Payable · ${b.name}`);
      await post(db, {
        kind: 'bill',
        description: `${b.name} · ${p.ref}`,
        idempotencyKey: `action:${actionId}`,
        meta: { actionId, biller: b.id, ref: p.ref },
        lines: [
          { account: walletCode(citizenId), amount: p.amount },
          { account: `payable:biller:${b.id}`, amount: -p.amount },
        ],
      });
      if (packBiller(b.id)?.category === 'electricity') {
        const token = await ctx.vending.electricityToken(p.ref, p.amount);
        await notify(db, citizenId, 'Electricity token', `${token} (${fmt(p.amount)}, meter ${p.ref})`, { sms: true });
        return { message: `Paid ${fmt(p.amount)}. Your electricity token is ${token}.`, token };
      }
      await notify(db, citizenId, 'Bill paid', `${fmt(p.amount)} to ${b.name}, account ${p.ref}.`, { sms: false });
      return { message: `Paid ${fmt(p.amount)} to ${b.name}.` };
    },
  },

  buy_airtime: {
    requiresPin: true,
    schema: z.object({ network: oneOf(() => networks().map((n) => n.id), 'network'), phone: z.string().optional(), amount }),
    async prepare(db, _ctx, citizenId, p) {
      const me = await citizenName(db, citizenId);
      const phone = p.phone ? normalisePhone(p.phone) : me.phone;
      const { airtimeMin, airtimeMax } = country().limits;
      if (p.amount < airtimeMin || p.amount > airtimeMax) throw badRequest('limit', `Airtime is from ${fmt(airtimeMin)} to ${fmt(airtimeMax)}`);
      await requireFunds(db, citizenId, p.amount);
      const net = packBiller(p.network)!.name;
      return {
        params: { network: p.network, phone, amount: p.amount },
        label: `Buy ${fmt(p.amount)} ${net} airtime`,
        amount: p.amount,
        readback: [['Network', net], ['Number', maskPhone(phone)], ['Amount', fmt(p.amount)]],
      };
    },
    async execute(db, ctx, citizenId, p, actionId) {
      await ensureAccount(db, `payable:biller:${p.network}`, 'liability', `Payable · ${p.network}`);
      await post(db, {
        kind: 'airtime',
        description: `${packBiller(p.network)?.name ?? p.network} airtime`,
        idempotencyKey: `action:${actionId}`,
        meta: { actionId },
        lines: [
          { account: walletCode(citizenId), amount: p.amount },
          { account: `payable:biller:${p.network}`, amount: -p.amount },
        ],
      });
      await ctx.vending.airtime(p.network, p.phone, p.amount);
      return { message: `Bought ${fmt(p.amount)} airtime for ${maskPhone(p.phone)}.` };
    },
  },

  top_up: {
    requiresPin: true,
    schema: z.object({ source: oneOf(() => country().topUpSources.map((s) => s.id), 'top-up source'), amount }),
    async prepare(_db, _ctx, _citizenId, p) {
      if (p.amount > country().limits.topUpMax) throw badRequest('limit', `The top-up limit is ${fmt(country().limits.topUpMax)}`);
      const name = sourceName(p.source);
      return {
        params: { source: p.source, amount: p.amount },
        label: `Top up ${fmt(p.amount)} from ${name}`,
        amount: p.amount,
        readback: [['From', name], ['Amount', fmt(p.amount)], ['Fee', fmt(0)]],
      };
    },
    // Production: request a collection from the mobile-money operator and credit
    // the wallet on its success callback. The demo credits immediately.
    async execute(db, _ctx, citizenId, p, actionId) {
      const code = `settlement:${p.source}`;
      await ensureAccount(db, code, 'asset', `Settlement · ${p.source}`);
      await post(db, {
        kind: 'top_up',
        description: `Top up from ${sourceName(p.source)}`,
        idempotencyKey: `action:${actionId}`,
        meta: { actionId },
        lines: [
          { account: code, amount: p.amount },
          { account: walletCode(citizenId), amount: -p.amount },
        ],
      });
      return { message: `Added ${fmt(p.amount)} to your wallet.` };
    },
  },

  licence_renewal: {
    requiresPin: true,
    schema: z.object({ eyeTest: z.object({ locationId: z.string(), startsAt: z.string() }) }),
    async prepare(db, ctx, citizenId, p) {
      const t = await getTemplate(db, 'driver_licence_renewal');
      const lic = await one<any>(db, `SELECT data, valid_to FROM documents WHERE citizen_id = $1 AND type = 'driver_licence' AND status = 'valid'`, [citizenId]);
      if (!lic) throw badRequest('no_licence', `You have no driver's licence on record. Visit ${country().agencies.licence.code} to apply for a first licence.`);
      const open = await one(db, `SELECT ref FROM applications WHERE citizen_id = $1 AND template_code = 'driver_licence_renewal' AND status = 'open'`, [citizenId]);
      if (open) throw conflict('already_open', `You already have a renewal in progress (${(open as any).ref}).`);
      const loc = await one<any>(db, `SELECT id, name FROM locations WHERE id = $1 AND kind = 'eye_test'`, [p.eyeTest.locationId]);
      if (!loc) throw badRequest('invalid_location', 'Choose an eye-test location');
      const at = new Date(p.eyeTest.startsAt);
      await requireFunds(db, citizenId, t.fee);
      return {
        params: { eyeTest: { locationId: loc.id, startsAt: at.toISOString() }, licenceClass: lic.data.licence_class ?? 'B' },
        label: `Pay ${fmt(t.fee)} and renew licence`,
        amount: t.fee,
        readback: [
          ['Service', `${t.name} · ${country().licence.classWord} ${lic.data.licence_class ?? 'B'}`],
          ['Eye test', `${dayLabel(at)} ${timeLabel(at)} · ${loc.name}`],
          ['Collect card at', country().licence.collectAt],
          ['Fee', fmt(t.fee)],
        ],
      };
    },
    async execute(db, _ctx, citizenId, p) {
      const app = await openApplication(db, citizenId, 'driver_licence_renewal', { licence_class: p.licenceClass }, `citizen:${citizenId}`);
      await book(db, citizenId, p.eyeTest.locationId, p.eyeTest.startsAt, 'Eye test for licence renewal', app.id);
      return { message: `Submitted. Reference ${app.ref}.`, ref: app.ref, applicationId: app.id };
    },
  },

  birth_certificate: {
    requiresPin: true,
    schema: z.object({}).passthrough(),
    async prepare(db, _ctx, citizenId) {
      const t = await getTemplate(db, 'birth_certificate_copy');
      await requireFunds(db, citizenId, t.fee);
      const me = await citizenName(db, citizenId);
      return {
        params: {},
        label: `Pay ${fmt(t.fee)} for a birth certificate copy`,
        amount: t.fee,
        readback: [['Service', `${t.name} (digital copy)`], ['For', `${me.first_name} ${me.last_name}`], ['Delivered to', 'Your Vault'], ['Fee', fmt(t.fee)]],
      };
    },
    async execute(db, _ctx, citizenId) {
      const app = await openApplication(db, citizenId, 'birth_certificate_copy', {}, `citizen:${citizenId}`);
      return { message: `Requested. Reference ${app.ref}.`, ref: app.ref, applicationId: app.id };
    },
  },

  tax_clearance: {
    requiresPin: false,
    schema: z.object({}).passthrough(),
    async prepare(db, ctx, citizenId) {
      const t = await getTemplate(db, 'tax_clearance');
      const tax = country().agencies.tax.code;
      const c = await one<any>(db, 'SELECT omang_hash FROM citizens WHERE id = $1', [citizenId]);
      const rec = await ctx.registry.findByHash(c.omang_hash);
      if (rec && !rec.taxCompliant) {
        throw conflict('not_compliant', `${tax} shows outstanding returns or tax owed. Contact ${tax} to settle them first.`);
      }
      return {
        params: {},
        label: `Issue ${t.name.toLowerCase()}`,
        amount: 0,
        readback: [['Service', t.name], ['From', tax], ['Valid for', `${t.output?.validDays ?? 90} days`], ['Fee', fmt(0)]],
      };
    },
    async execute(db, _ctx, citizenId) {
      const app = await openApplication(db, citizenId, 'tax_clearance', {}, `citizen:${citizenId}`);
      return { message: `Issued. Certificate ${app.ref} is in your Vault.`, ref: app.ref };
    },
  },

  book_appointment: {
    requiresPin: false,
    schema: z.object({ locationId: z.string(), startsAt: z.string(), purpose: z.string().max(80).optional() }),
    async prepare(db, _ctx, _citizenId, p) {
      const loc = await one<any>(db, `SELECT id, name, kind FROM locations WHERE id = $1 AND kind IN ('clinic','passport')`, [p.locationId]);
      if (!loc) throw badRequest('invalid_location', 'Choose a clinic or passport office');
      const at = new Date(p.startsAt);
      if (isNaN(at.getTime())) throw badRequest('invalid_slot', 'Choose a time');
      const purpose = p.purpose || (loc.kind === 'clinic' ? 'Clinic visit' : 'Passport application');
      return {
        params: { locationId: loc.id, startsAt: at.toISOString(), purpose },
        label: `Book ${dayLabel(at)} ${timeLabel(at)}`,
        amount: 0,
        readback: [['Where', loc.name], ['When', `${dayLabel(at)} at ${timeLabel(at)}`], ['For', purpose]],
      };
    },
    async execute(db, _ctx, citizenId, p) {
      const a = await book(db, citizenId, p.locationId, p.startsAt, p.purpose);
      return { message: `Booked: ${a.where}, ${dayLabel(a.startsAt)} at ${timeLabel(a.startsAt)}.`, appointmentId: a.id };
    },
  },

  queue_ticket: {
    requiresPin: false,
    schema: z.object({ locationId: z.string(), service: z.string() }),
    async prepare(db, _ctx, _citizenId, p) {
      const loc = await one<any>(db, `SELECT id, name, services FROM locations WHERE id = $1 AND kind = 'office'`, [p.locationId]);
      if (!loc) throw badRequest('invalid_location', 'Choose an office');
      if (!(loc.services as string[]).includes(p.service)) throw badRequest('invalid_service', `Choose one of: ${loc.services.join(', ')}`);
      return {
        params: { locationId: loc.id, service: p.service },
        label: `Get a ticket at ${loc.name.split(' · ')[0]}`,
        amount: 0,
        readback: [['Office', loc.name], ['Service', p.service]],
      };
    },
    async execute(db, _ctx, citizenId, p) {
      const t = await takeTicket(db, { citizenId }, p.locationId, p.service);
      return { message: `Your ticket is ${t.label}. ${t.ahead} people ahead.`, ticket: t.label, ahead: t.ahead };
    },
  },
};

export const ACTION_TYPES = Object.keys(defs);

export function viewAction(r: any) {
  const d = defs[r.type];
  return {
    id: r.id,
    type: r.type,
    label: r.readback_label ?? r.params?.__label ?? null,
    readback: r.readback,
    amount: r.amount,
    amountText: fmt(r.amount),
    requiresPin: d?.requiresPin ?? true,
    source: r.source,
    status: r.status,
    result: r.result,
    error: r.error,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

/** Validate and prepare an action. Nothing is charged or submitted. */
export async function createAction(db: Queryable, ctx: ActionCtx, citizenId: string, type: string, rawParams: unknown, source: Source) {
  const d = defs[type];
  if (!d) throw badRequest('unknown_action', `Unknown action: ${type}`);
  const parsed = d.schema.safeParse(rawParams ?? {});
  if (!parsed.success) throw badRequest('invalid_params', 'Some details are missing or wrong', parsed.error.flatten());
  const prep = await d.prepare(db, ctx, citizenId, parsed.data);
  const r = await one<any>(
    db,
    `INSERT INTO pending_actions (citizen_id, type, params, readback, amount, source, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7)) RETURNING *`,
    [citizenId, type, JSON.stringify({ ...prep.params, __label: prep.label }), JSON.stringify(prep.readback), prep.amount, source, config.actionTtlMinutes],
  );
  return viewAction(r);
}

/**
 * Confirm and execute. PIN (when required) is checked in its own transaction
 * so wrong attempts are always counted. The action row is locked so a double
 * tap or a retried request can never execute twice.
 */
export async function confirmAction(pool: pg.Pool, ctx: ActionCtx, citizenId: string, actionId: string, pin?: string) {
  const a = await one<any>(pool, 'SELECT * FROM pending_actions WHERE id = $1 AND citizen_id = $2', [actionId, citizenId]);
  if (!a) throw notFound('Action not found');
  const d = defs[a.type];
  if (a.status !== 'pending') return viewAction(a);
  if (d.requiresPin) {
    if (!pin) throw new AppError(401, 'pin_required', 'Enter your PIN to confirm');
    await verifyPin(pool, citizenId, pin);
  }
  try {
    const done = await tx(pool, async (c) => {
      const row = await one<any>(c, 'SELECT * FROM pending_actions WHERE id = $1 FOR UPDATE', [actionId]);
      if (row.status !== 'pending') return row;
      if (new Date(row.expires_at) < new Date()) {
        return one<any>(c, `UPDATE pending_actions SET status = 'expired', decided_at = now() WHERE id = $1 RETURNING *`, [actionId]);
      }
      const { __label, ...params } = row.params;
      void __label;
      const result = await d.execute(c, ctx, citizenId, params, actionId);
      await audit(c, row.source === 'assistant' ? `assistant:${citizenId}` : `citizen:${citizenId}`, `action.${row.type}`, `action:${actionId}`, {
        source: row.source,
        amount: row.amount,
        confirmedWith: d.requiresPin ? 'pin' : 'tap',
      });
      return one<any>(c, `UPDATE pending_actions SET status = 'done', result = $2, decided_at = now() WHERE id = $1 RETURNING *`, [actionId, JSON.stringify(result)]);
    });
    if (done.status === 'expired') throw new AppError(410, 'expired', 'This confirmation expired. Start again.');
    return viewAction(done);
  } catch (e) {
    if (e instanceof AppError && e.code !== 'expired') {
      await pool.query(`UPDATE pending_actions SET status = 'failed', error = $2, decided_at = now() WHERE id = $1 AND status = 'pending'`, [actionId, e.message]);
    }
    throw e;
  }
}

export async function cancelAction(db: Queryable, citizenId: string, actionId: string) {
  const r = await one<any>(db, `UPDATE pending_actions SET status = 'cancelled', decided_at = now() WHERE id = $1 AND citizen_id = $2 AND status = 'pending' RETURNING *`, [actionId, citizenId]);
  if (!r) throw notFound('Nothing to cancel');
  return viewAction(r);
}

export async function getAction(db: Queryable, citizenId: string, actionId: string) {
  const r = await one<any>(db, 'SELECT * FROM pending_actions WHERE id = $1 AND citizen_id = $2', [actionId, citizenId]);
  if (!r) throw notFound('Action not found');
  return viewAction(r);
}

export async function recentActions(db: Queryable, citizenId: string) {
  return (await many<any>(db, 'SELECT * FROM pending_actions WHERE citizen_id = $1 ORDER BY created_at DESC LIMIT 20', [citizenId])).map(viewAction);
}
