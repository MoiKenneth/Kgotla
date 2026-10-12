import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { trialBalance } from '../src/modules/ledger.js';
import { balance, call, harness, login, MPHO, NALEDI, type Harness } from './helpers.js';

let h: Harness;
let naledi: string;
let mpho: string;

beforeAll(async () => {
  h = await harness();
  naledi = await login(h.app, NALEDI);
  mpho = await login(h.app, MPHO);
});
afterAll(() => h.close());

describe('wallet and confirmable actions', () => {
  it('preparing an action moves no money', async () => {
    const before = await balance(h.app, naledi);
    const r = await call(h.app, naledi, 'POST', '/v1/actions', { type: 'send_money', params: { to: MPHO.phone, amount: '200' } });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('pending');
    expect(r.json.requiresPin).toBe(true);
    expect(r.json.readback).toContainEqual(['Amount', 'P 200.00']);
    expect(r.json.readback).toContainEqual(['To', 'Mpho K.']);
    expect(await balance(h.app, naledi)).toBe(before);
  });

  it('needs the PIN, counts wrong PINs, executes once', async () => {
    const before = await balance(h.app, naledi);
    const mBefore = await balance(h.app, mpho);
    const a = (await call(h.app, naledi, 'POST', '/v1/actions', { type: 'send_money', params: { to: MPHO.phone, amount: 120.5 } })).json;

    expect((await call(h.app, naledi, 'POST', `/v1/actions/${a.id}/confirm`, {})).json.error.code).toBe('pin_required');
    const wrong = await call(h.app, naledi, 'POST', `/v1/actions/${a.id}/confirm`, { pin: '0000' });
    expect(wrong.status).toBe(401);
    expect(wrong.json.error.code).toBe('wrong_pin');
    const f = await h.pool.query('SELECT pin_failures FROM citizens WHERE phone = $1', [NALEDI.phone]);
    expect(f.rows[0].pin_failures).toBe(1);

    const ok = await call(h.app, naledi, 'POST', `/v1/actions/${a.id}/confirm`, { pin: NALEDI.pin });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe('done');
    // A double tap returns the same result and does not pay twice.
    const again = await call(h.app, naledi, 'POST', `/v1/actions/${a.id}/confirm`, { pin: NALEDI.pin });
    expect(again.json.status).toBe('done');
    expect(await balance(h.app, naledi)).toBe(before - 12050);
    expect(await balance(h.app, mpho)).toBe(mBefore + 12050);
  });

  it('refuses to overdraw, even when confirmations race', async () => {
    const start = await balance(h.app, naledi);
    const amount = 50000; // P 500
    const n = Math.floor(start / amount) + 3;
    // Prepare more transfers than the wallet can pay. Preparing checks funds,
    // so create them while funds look sufficient, then race the confirmations.
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = await h.pool.query(
        `INSERT INTO pending_actions (citizen_id, type, params, readback, amount, source, expires_at)
         SELECT c.id, 'send_money', jsonb_build_object('toCitizenId', m.id, 'amount', $1::bigint, '__label', 'race'), '[]', $1, 'app', now() + interval '5 minutes'
           FROM citizens c, citizens m WHERE c.phone = $2 AND m.phone = $3 RETURNING id`,
        [amount, NALEDI.phone, MPHO.phone],
      );
      ids.push(r.rows[0].id);
    }
    const results = await Promise.all(ids.map((id) => call(h.app, naledi, 'POST', `/v1/actions/${id}/confirm`, { pin: NALEDI.pin })));
    const done = results.filter((r) => r.status === 200 && r.json.status === 'done').length;
    const refused = results.filter((r) => r.json?.error?.code === 'insufficient_funds').length;
    expect(done).toBe(Math.floor(start / amount));
    expect(done + refused).toBe(n);
    expect(await balance(h.app, naledi)).toBe(start - done * amount);
    expect(await balance(h.app, naledi)).toBeGreaterThanOrEqual(0);
    expect(await trialBalance(h.pool)).toBe(0);
  });

  it('pays BPC and returns a 20-digit token', async () => {
    await call(h.app, mpho, 'POST', '/v1/actions', { type: 'top_up', params: { source: 'orange_money', amount: 500 } }).then((r) =>
      call(h.app, mpho, 'POST', `/v1/actions/${r.json.id}/confirm`, { pin: MPHO.pin }),
    );
    const a = (await call(h.app, mpho, 'POST', '/v1/actions', { type: 'pay_bill', params: { biller: 'bpc', ref: '0412 778 8330', amount: 150 } })).json;
    const done = (await call(h.app, mpho, 'POST', `/v1/actions/${a.id}/confirm`, { pin: MPHO.pin })).json;
    expect(done.result.token.replace(/\s/g, '')).toMatch(/^\d{20}$/);
  });

  it('validates bill references and transfer targets', async () => {
    expect((await call(h.app, mpho, 'POST', '/v1/actions', { type: 'pay_bill', params: { biller: 'bpc', ref: '123', amount: 50 } })).json.error.code).toBe('invalid_reference');
    expect((await call(h.app, mpho, 'POST', '/v1/actions', { type: 'send_money', params: { to: MPHO.phone, amount: 5 } })).json.error.code).toBe('self_transfer');
    expect((await call(h.app, mpho, 'POST', '/v1/actions', { type: 'send_money', params: { to: '+26779999999', amount: 5 } })).status).toBe(404);
    expect((await call(h.app, mpho, 'POST', '/v1/actions', { type: 'send_money', params: { to: NALEDI.phone, amount: '5.555' } })).json.error.code).toBe('invalid_amount');
  });

  it('malformed ids are a clean 404, not a server error', async () => {
    expect((await call(h.app, mpho, 'POST', '/v1/actions/undefined/confirm', { pin: MPHO.pin })).status).toBe(404);
  });

  it('cannot confirm another citizen\'s action', async () => {
    const a = (await call(h.app, mpho, 'POST', '/v1/actions', { type: 'top_up', params: { source: 'myzaka', amount: 10 } })).json;
    expect((await call(h.app, naledi, 'POST', `/v1/actions/${a.id}/confirm`, { pin: NALEDI.pin })).status).toBe(404);
  });

  it('expired actions do not execute', async () => {
    const a = (await call(h.app, mpho, 'POST', '/v1/actions', { type: 'top_up', params: { source: 'myzaka', amount: 10 } })).json;
    await h.pool.query(`UPDATE pending_actions SET expires_at = now() - interval '1 second' WHERE id = $1`, [a.id]);
    const r = await call(h.app, mpho, 'POST', `/v1/actions/${a.id}/confirm`, { pin: MPHO.pin });
    expect(r.status).toBe(410);
  });

  it('the database itself rejects unbalanced or edited postings', async () => {
    const acct = (await h.pool.query(`SELECT id FROM ledger_accounts WHERE code LIKE 'wallet:%' LIMIT 1`)).rows[0].id;
    const c = await h.pool.connect();
    try {
      await c.query('BEGIN');
      const e = await c.query(`INSERT INTO journal_entries (kind, description) VALUES ('x','x') RETURNING id`);
      await c.query('INSERT INTO postings (entry_id, account_id, amount) VALUES ($1,$2,100)', [e.rows[0].id, acct]);
      await expect(c.query('COMMIT')).rejects.toThrow(/does not balance/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    await expect(h.pool.query('UPDATE postings SET amount = amount + 1 WHERE id = (SELECT min(id) FROM postings)')).rejects.toThrow(/append-only/);
    expect(await trialBalance(h.pool)).toBe(0);
  });
});
