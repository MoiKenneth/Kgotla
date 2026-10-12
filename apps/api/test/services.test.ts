import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../src/lib/audit.js';
import { trialBalance } from '../src/modules/ledger.js';
import { balance, call, harness, KABELO, login, MPHO, NALEDI, officerLogin, type Harness } from './helpers.js';

let h: Harness;
let naledi: string;
beforeAll(async () => {
  h = await harness();
  naledi = await login(h.app, NALEDI);
});
afterAll(() => h.close());

async function firstSlot(token: string, locationId: string) {
  const a = (await call(h.app, token, 'GET', `/v1/locations/${locationId}/availability`)).json;
  return a.days[0].slots.find((s: any) => s.available).startsAt as string;
}

describe('government services', () => {
  it("renews a driver's licence end to end", async () => {
    const before = await balance(h.app, naledi);
    const startsAt = await firstSlot(naledi, 'eye-gbe-drts');
    const a = (await call(h.app, naledi, 'POST', '/v1/actions', { type: 'licence_renewal', params: { eyeTest: { locationId: 'eye-gbe-drts', startsAt } } })).json;
    expect(a.amountText).toBe('P 150.00');
    const done = (await call(h.app, naledi, 'POST', `/v1/actions/${a.id}/confirm`, { pin: NALEDI.pin })).json;
    expect(done.result.ref).toMatch(/^DL-\d{4}-\d{5}$/);
    expect(await balance(h.app, naledi)).toBe(before - 15000);

    // A second renewal while one is open is refused.
    expect((await call(h.app, naledi, 'POST', '/v1/actions', { type: 'licence_renewal', params: { eyeTest: { locationId: 'eye-gbe-drts', startsAt } } })).json.error.code).toBe('already_open');

    const me = (await call(h.app, naledi, 'GET', '/v1/me')).json;
    expect(me.appointments.some((x: any) => x.purpose.includes('Eye test'))).toBe(true);
    const app = me.applications.find((x: any) => x.ref === done.result.ref);

    // CNR cannot touch a DRTS application.
    const cnr = await officerLogin(h.app, 'cnr.case');
    expect((await call(h.app, cnr, 'POST', `/v1/officer/applications/${app.id}/advance`, {})).status).toBe(403);
    // Citizens cannot use officer endpoints.
    expect((await call(h.app, naledi, 'GET', '/v1/officer/applications')).status).toBe(403);

    const drts = await officerLogin(h.app, 'drts.case');
    const queue = (await call(h.app, drts, 'GET', '/v1/officer/applications')).json;
    expect(queue.some((x: any) => x.ref === done.result.ref)).toBe(true);
    for (let i = 0; i < 3; i++) expect((await call(h.app, drts, 'POST', `/v1/officer/applications/${app.id}/advance`, {})).status).toBe(200);

    const after = (await call(h.app, naledi, 'GET', '/v1/me')).json;
    const lic = after.documents.filter((d: any) => d.type === 'driver_licence');
    expect(lic).toHaveLength(1); // the old one is superseded
    const years = (new Date(lic[0].valid_to).getTime() - Date.now()) / (365.25 * 86400_000);
    expect(years).toBeGreaterThan(4.9);
    expect(after.applications.find((x: any) => x.ref === done.result.ref).status).toBe('completed');
    expect((await call(h.app, drts, 'POST', `/v1/officer/applications/${app.id}/advance`, {})).json.error.code).toBe('not_open');
  });

  it('rejection refunds the fee', async () => {
    const mpho = await login(h.app, MPHO);
    const before = await balance(h.app, mpho);
    const a = (await call(h.app, mpho, 'POST', '/v1/actions', { type: 'birth_certificate', params: {} })).json;
    const done = (await call(h.app, mpho, 'POST', `/v1/actions/${a.id}/confirm`, { pin: MPHO.pin })).json;
    expect(await balance(h.app, mpho)).toBe(before - 1000);
    const cnr = await officerLogin(h.app, 'cnr.case');
    expect((await call(h.app, cnr, 'POST', `/v1/officer/applications/${done.result.applicationId}/reject`, { reason: 'no' })).status).toBe(400);
    expect((await call(h.app, cnr, 'POST', `/v1/officer/applications/${done.result.applicationId}/reject`, { reason: 'Record needs a correction at the CNR office first.' })).status).toBe(200);
    expect(await balance(h.app, mpho)).toBe(before);
  });

  it('issues tax clearance instantly, and refuses when BURS shows arrears', async () => {
    const a = (await call(h.app, naledi, 'POST', '/v1/actions', { type: 'tax_clearance', params: {} })).json;
    expect(a.requiresPin).toBe(false);
    const done = (await call(h.app, naledi, 'POST', `/v1/actions/${a.id}/confirm`, {})).json;
    expect(done.status).toBe('done');
    const me = (await call(h.app, naledi, 'GET', '/v1/me')).json;
    expect(me.documents.some((d: any) => d.type === 'tax_clearance')).toBe(true);

    await h.pool.query(`UPDATE registry_mock.people SET tax_compliant = false WHERE omang = $1`, [KABELO.omang]);
    const kabelo = await login(h.app, KABELO);
    expect((await call(h.app, kabelo, 'POST', '/v1/actions', { type: 'tax_clearance', params: {} })).json.error.code).toBe('not_compliant');
  });

  it('books within capacity and blocks double booking', async () => {
    const startsAt = await firstSlot(naledi, 'clinic-bontleng');
    const a = (await call(h.app, naledi, 'POST', '/v1/actions', { type: 'book_appointment', params: { locationId: 'clinic-bontleng', startsAt } })).json;
    expect((await call(h.app, naledi, 'POST', `/v1/actions/${a.id}/confirm`, {})).json.status).toBe('done');
    const b = (await call(h.app, naledi, 'POST', '/v1/actions', { type: 'book_appointment', params: { locationId: 'clinic-bontleng', startsAt } })).json;
    expect((await call(h.app, naledi, 'POST', `/v1/actions/${b.id}/confirm`, {})).json.error.code).toBe('double_booking');
  });

  it('smart queue: ticket, call next, near-turn notice', async () => {
    const tokens = [naledi, await login(h.app, MPHO), await login(h.app, KABELO)];
    const labels: string[] = [];
    for (const t of tokens) {
      const a = (await call(h.app, t, 'POST', '/v1/actions', { type: 'queue_ticket', params: { locationId: 'drts-mainmall', service: 'Licence collection' } })).json;
      labels.push((await call(h.app, t, 'POST', `/v1/actions/${a.id}/confirm`, {})).json.result.ticket);
    }
    expect(labels).toEqual(['A-001', 'A-002', 'A-003']);
    const dup = (await call(h.app, naledi, 'POST', '/v1/actions', { type: 'queue_ticket', params: { locationId: 'drts-mainmall', service: 'Licence collection' } })).json;
    expect((await call(h.app, naledi, 'POST', `/v1/actions/${dup.id}/confirm`, {})).json.error.code).toBe('already_queued');

    expect((await call(h.app, tokens[2], 'GET', '/v1/me')).json.queue.ahead).toBe(2);
    const counter = await officerLogin(h.app, 'drts.counter');
    const called = (await call(h.app, counter, 'POST', '/v1/officer/queue/drts-mainmall/call-next', { counter: 3 })).json;
    expect(called.label).toBe('A-001');
    const me = (await call(h.app, naledi, 'GET', '/v1/me')).json;
    expect(me.queue.status).toBe('called');
    expect(me.notifications[0].body).toContain('counter 3');
    expect((await call(h.app, tokens[2], 'GET', '/v1/me')).json.queue.ahead).toBe(1);
  });

  it('issuers put documents straight into the Vault', async () => {
    const bad = await h.app.inject({ method: 'POST', url: '/v1/issuer/documents', headers: { 'x-issuer-id': 'BEC', 'x-issuer-key': 'wrong' }, payload: { omang: NALEDI.omang, type: 'results', title: 'x' } });
    expect(bad.statusCode).toBe(401);
    const ok = await h.app.inject({
      method: 'POST',
      url: '/v1/issuer/documents',
      headers: { 'x-issuer-id': 'BEC', 'x-issuer-key': 'demo-issuer-key-bec' },
      payload: { omang: NALEDI.omang, type: 'bgcse_results', title: 'BGCSE certificate (2008)', ref: 'BEC-2008-118204' },
    });
    expect(ok.statusCode).toBe(200);
    expect((await call(h.app, naledi, 'GET', '/v1/me')).json.documents.some((d: any) => d.title === 'BGCSE certificate (2008)')).toBe(true);
  });

  it('the books balance and the audit chain is intact', async () => {
    expect(await trialBalance(h.pool)).toBe(0);
    expect(await verifyAuditChain(h.pool)).toBeNull();
    const admin = await officerLogin(h.app, 'admin');
    const o = (await call(h.app, admin, 'GET', '/v1/officer/overview')).json;
    expect(o.ledgerBalanced).toBe(true);
    expect(o.auditChainIntact).toBe(true);
    await expect(h.pool.query(`UPDATE audit_log SET actor = 'x' WHERE id = 1`)).rejects.toThrow(/append-only/);
  });
});
