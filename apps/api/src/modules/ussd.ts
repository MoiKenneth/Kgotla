import type pg from 'pg';
import { one, tx } from '../db.js';
import { country, electricity } from '../countries/index.js';
import { AppError } from '../lib/errors.js';
import { PinError, verifyPin } from '../lib/auth.js';
import { fmt } from '../lib/money.js';
import { dateLabel } from '../lib/time.js';
import { confirmAction, createAction, type ActionCtx } from './actions.js';
import { listApplications } from './gov.js';
import { normalisePhone } from './identity.js';
import { walletBalance } from './ledger.js';
import { queueOffices, takeTicket } from './places.js';

/**
 * USSD menu (*321#) in the Africa's Talking callback format: the gateway posts
 * sessionId, phoneNumber and the cumulative input "1*2*500", and we answer with
 * "CON <menu>" to continue or "END <text>" to close. Works on any phone, no data.
 * Money moves only through confirmable actions confirmed with the PIN.
 */

type Lang = 'en' | 'tn';
const T = {
  en: {
    main: 'Kgotla\n1. My ID\n2. Wallet balance\n3. Send money\n4. Buy electricity ({elec})\n5. Government services\n6. Queue ticket',
    guest: 'Kgotla\n1. Queue ticket\n2. How to register',
    register: 'Register in the Kgotla app or at any Kgotla agent (post offices, kiosks) with your {id}.',
    pin: 'Enter your PIN:',
    toNumber: 'Enter the mobile number to send to:',
    amount: 'Enter amount in pula:',
    meter: 'Enter your {elec} meter number:',
    confirm: (rb: string) => `${rb}\nEnter PIN to confirm, or 0 to cancel:`,
    cancelled: 'Cancelled. Nothing was paid.',
    gov: 'Government services\n1. Licence status\n2. Tax clearance certificate\n3. My applications',
    taxConfirm: 'Issue a BURS tax clearance certificate to your Vault?\n1. Yes\n0. Cancel',
    office: 'Choose an office:',
    service: 'Choose a service:',
    invalid: 'Invalid choice.',
  },
  tn: {
    main: 'Kgotla\n1. Boitshupo jwa me\n2. Madi a me\n3. Romela madi\n4. Reka motlakase ({elec})\n5. Ditirelo tsa puso\n6. Tekete ya mola',
    guest: 'Kgotla\n1. Tekete ya mola\n2. Go ikwadisa jang',
    register: 'Ikwadise mo app ya Kgotla kgotsa kwa moemeding wa Kgotla ka {id} ya gago.',
    pin: 'Tsenya PIN ya gago:',
    toNumber: 'Tsenya nomoro ya mogala:',
    amount: 'Tsenya palo ya madi:',
    meter: 'Tsenya nomoro ya mitara ya {elec}:',
    confirm: (rb: string) => `${rb}\nTsenya PIN go netefatsa, kgotsa 0 go khansela:`,
    cancelled: 'Go khanselitswe. Ga go sepe se se duetsweng.',
    gov: 'Ditirelo tsa puso\n1. Maemo a laesense\n2. Setlankana sa lekgetho\n3. Dikopo tsa me',
    taxConfirm: 'Ntsha setlankana sa lekgetho mo Polokelong?\n1. Ee\n0. Khansela',
    office: 'Tlhopha ofisi:',
    service: 'Tlhopha tirelo:',
    invalid: 'Tlhopho e e sa siamang.',
  },
};

/** Put this cell's electricity provider and ID name into the menu text. */
function fill<T extends Record<string, unknown>>(texts: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(texts)) {
    out[k] = typeof v === 'string' ? v.replace(/\{elec\}/g, electricity().short).replace(/\{id\}/g, country().nationalId.short) : v;
  }
  return out as T;
}

const CON = (s: string) => `CON ${s}`;
const END = (s: string) => `END ${s}`;

async function state(pool: pg.Pool, sessionId: string, phone: string) {
  const r = await one<any>(pool, 'SELECT state FROM ussd_sessions WHERE session_id = $1', [sessionId]);
  if (r) return r.state as Record<string, any>;
  await pool.query('INSERT INTO ussd_sessions (session_id, phone) VALUES ($1,$2) ON CONFLICT DO NOTHING', [sessionId, phone]);
  return {};
}
async function saveState(pool: pg.Pool, sessionId: string, s: Record<string, any>) {
  await pool.query('UPDATE ussd_sessions SET state = $2, updated_at = now() WHERE session_id = $1', [sessionId, JSON.stringify(s)]);
}

export async function handleUssd(pool: pg.Pool, ctx: ActionCtx, input: { sessionId: string; phoneNumber: string; text: string }): Promise<string> {
  let phone: string;
  try {
    phone = normalisePhone(input.phoneNumber);
  } catch {
    return END('Unsupported number.');
  }
  // Inputs after the last "00" (restart) are the current path.
  const all = (input.text ?? '').split('*').filter((x) => x !== '');
  const restart = all.lastIndexOf('00');
  const path = restart >= 0 ? all.slice(restart + 1) : all;
  const citizen = await one<any>(pool, 'SELECT id, first_name, last_name, omang_last4, loa, lang FROM citizens WHERE phone = $1', [phone]);
  const L: Lang = citizen?.lang === 'tn' && country().languages.some((l) => l.code === 'tn') ? 'tn' : 'en';
  const t = fill(T[L]);
  const st = await state(pool, input.sessionId, phone);

  try {
    if (!citizen) {
      if (!path.length) return CON(t.guest);
      if (path[0] === '2') return END(t.register);
      if (path[0] === '1') return queueFlow(pool, path.slice(1), t, async (loc, svc) => {
        const tk = await tx(pool, (c) => takeTicket(c, { phone }, loc, svc));
        return END(`${tk.label}\n${tk.office}\n${tk.ahead} ${L === 'tn' ? 'pele ga gago. Re tla go romelela SMS.' : 'ahead. We will SMS you near your turn.'}`);
      });
      return END(t.invalid);
    }

    if (!path.length) return CON(t.main);
    const [choice, ...rest] = path;

    if (choice === '1') {
      return END(`${citizen.first_name} ${citizen.last_name[0]}.\n${country().nationalId.short} ***${citizen.omang_last4}\n${L === 'tn' ? 'Seelo' : 'Assurance level'} ${citizen.loa} · ${L === 'tn' ? 'E netefaditswe' : 'Verified'}`);
    }

    if (choice === '2') {
      if (!rest.length) return CON(t.pin);
      await verifyPin(pool, citizen.id, rest[0]);
      return END(`${L === 'tn' ? 'Madi a gago' : 'Your balance'}: ${fmt(await walletBalance(pool, citizen.id))}`);
    }

    if (choice === '3' || choice === '4') {
      const isSend = choice === '3';
      if (rest.length === 0) return CON(isSend ? t.toNumber : t.meter);
      if (rest.length === 1) return CON(t.amount);
      const key = `${choice}:${rest[0]}:${rest[1]}`;
      if (rest.length === 2) {
        const view = await tx(pool, (c) =>
          createAction(c, ctx, citizen.id, isSend ? 'send_money' : 'pay_bill', isSend ? { to: rest[0], amount: rest[1] } : { biller: electricity().id, ref: rest[0], amount: rest[1] }, 'ussd'),
        );
        await saveState(pool, input.sessionId, { ...st, [key]: view.id });
        return CON(t.confirm(view.readback.map(([k, v]: [string, string]) => `${k}: ${v}`).join('\n')));
      }
      const actionId = st[key];
      if (!actionId) return END(t.invalid);
      if (rest[2] === '0') {
        await pool.query(`UPDATE pending_actions SET status = 'cancelled', decided_at = now() WHERE id = $1 AND status = 'pending'`, [actionId]);
        return END(t.cancelled);
      }
      const done = await confirmAction(pool, ctx, citizen.id, actionId, rest[2]);
      return END(String(done.result?.message ?? 'Done.'));
    }

    if (choice === '5') {
      if (!rest.length) return CON(t.gov);
      if (rest[0] === '1') {
        const open = await one<any>(pool, `SELECT a.ref, a.step, t.steps FROM applications a JOIN service_templates t ON t.code = a.template_code
                                             WHERE a.citizen_id = $1 AND a.template_code = 'driver_licence_renewal' AND a.status = 'open'`, [citizen.id]);
        if (open) return END(`${open.ref}\n${open.steps[open.step].label}`);
        const d = await one<any>(pool, `SELECT valid_to FROM documents WHERE citizen_id = $1 AND type = 'driver_licence' AND status = 'valid'`, [citizen.id]);
        return END(d ? `${L === 'tn' ? 'Laesense e dira go fitlha' : 'Licence valid to'} ${dateLabel(d.valid_to, L)}` : (L === 'tn' ? 'Ga go laesense.' : 'No licence on record.'));
      }
      if (rest[0] === '2') {
        if (rest.length === 1) return CON(t.taxConfirm);
        if (rest[1] !== '1') return END(t.cancelled);
        const view = await tx(pool, (c) => createAction(c, ctx, citizen.id, 'tax_clearance', {}, 'ussd'));
        const done = await confirmAction(pool, ctx, citizen.id, view.id);
        return END(String(done.result?.message ?? 'Done.'));
      }
      if (rest[0] === '3') {
        const apps = (await listApplications(pool, { citizenId: citizen.id })).slice(0, 3);
        return END(apps.length ? apps.map((a) => `${a.ref}: ${a.steps[a.step]?.label ?? a.status}`).join('\n') : (L === 'tn' ? 'Ga go na dikopo.' : 'No applications.'));
      }
      return END(t.invalid);
    }

    if (choice === '6') {
      return queueFlow(pool, rest, t, async (loc, svc) => {
        const view = await tx(pool, (c) => createAction(c, ctx, citizen.id, 'queue_ticket', { locationId: loc, service: svc }, 'ussd'));
        const done = await confirmAction(pool, ctx, citizen.id, view.id);
        return END(String(done.result?.message ?? 'Done.'));
      });
    }
    return END(t.invalid);
  } catch (e: any) {
    if (e instanceof PinError || e instanceof AppError) return END(e.message);
    throw e;
  }
}

async function queueFlow(pool: pg.Pool, rest: string[], t: (typeof T)['en'], take: (loc: string, svc: string) => Promise<string>) {
  const offices = await queueOffices(pool);
  if (!rest.length) return CON(`${t.office}\n${offices.map((o, i) => `${i + 1}. ${o.name}`).join('\n')}`);
  const o = offices[Number(rest[0]) - 1];
  if (!o) return END(t.invalid);
  const svcs = o.services as string[];
  if (rest.length === 1) return CON(`${t.service}\n${svcs.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
  const svc = svcs[Number(rest[1]) - 1];
  if (!svc) return END(t.invalid);
  return take(o.id, svc);
}
