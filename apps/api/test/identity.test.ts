import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, harness, KABELO, login, NALEDI, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(() => h.close());

const fakeSelfie = 'data:image/jpeg;base64,' + Buffer.alloc(4096, 7).toString('base64');

describe('enrolment and sign-in', () => {
  it('enrols a registry person: OTP, liveness, PIN -> assurance level 3 with Vault and wallet', async () => {
    const s = await call(h.app, null, 'POST', '/v1/enrol/start', { omang: '341 926 728' });
    expect(s.status).toBe(200);
    expect(s.json.phoneMasked).toBe('+267 75 •• •• 11');
    expect(s.json.demoOtp).toMatch(/^\d{6}$/);
    const id = s.json.enrolmentId;

    expect((await call(h.app, null, 'POST', `/v1/enrol/${id}/liveness`, { selfie: fakeSelfie })).json.error.code).toBe('otp_required');
    expect((await call(h.app, null, 'POST', `/v1/enrol/${id}/otp`, { code: '000000' })).json.ok).toBe(false);
    expect((await call(h.app, null, 'POST', `/v1/enrol/${id}/otp`, { code: s.json.demoOtp })).json.ok).toBe(true);
    expect((await call(h.app, null, 'POST', `/v1/enrol/${id}/liveness`, { selfie: 'data:image/jpeg;base64,AAAA' })).json.passed).toBe(false);
    expect((await call(h.app, null, 'POST', `/v1/enrol/${id}/liveness`, { selfie: fakeSelfie })).json.passed).toBe(true);
    expect((await call(h.app, null, 'POST', `/v1/enrol/${id}/complete`, { pin: '7777' })).json.error.code).toBe('weak_pin');
    const done = await call(h.app, null, 'POST', `/v1/enrol/${id}/complete`, { pin: '7391', lang: 'tn' });
    expect(done.status).toBe(200);

    const me = (await call(h.app, done.json.token, 'GET', '/v1/me')).json;
    expect(me.profile.loa).toBe(3);
    expect(me.profile.lang).toBe('tn');
    expect(me.documents.map((d: any) => d.type).sort()).toEqual(['driver_licence', 'omang']);
    // The raw Omang is never stored on the citizen or kept on the enrolment.
    const raw = await h.pool.query(`SELECT count(*)::int AS n FROM citizens WHERE omang_hash = '341926728' OR omang_last4 = '341926728'`);
    expect(raw.rows[0].n).toBe(0);
    const enr = await h.pool.query('SELECT omang FROM enrolments WHERE id = $1', [id]);
    expect(enr.rows[0].omang).toBe('');

    expect((await call(h.app, null, 'POST', '/v1/enrol/start', { omang: '341926728' })).json.error.code).toBe('already_enrolled');
  });

  it('rejects unknown and malformed Omang numbers', async () => {
    expect((await call(h.app, null, 'POST', '/v1/enrol/start', { omang: '123' })).json.error.code).toBe('invalid_national_id');
    expect((await call(h.app, null, 'POST', '/v1/enrol/start', { omang: '999999999' })).status).toBe(404);
  });

  it('locks the PIN after 5 wrong attempts, even for the right PIN', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await call(h.app, null, 'POST', '/v1/auth/login', { omang: KABELO.omang, pin: '1111' });
      expect(r.status).toBe(401);
    }
    const r = await call(h.app, null, 'POST', '/v1/auth/login', { omang: KABELO.omang, pin: KABELO.pin });
    expect(r.status).toBe(423);
  });

  it('logs out by revoking the session', async () => {
    const t = await login(h.app, NALEDI);
    expect((await call(h.app, t, 'GET', '/v1/me')).status).toBe(200);
    await call(h.app, t, 'POST', '/v1/auth/logout');
    expect((await call(h.app, t, 'GET', '/v1/me')).status).toBe(401);
  });

  it('shares only chosen claims, and verifiers can detect tampering', async () => {
    const t = await login(h.app, NALEDI);
    expect((await call(h.app, t, 'POST', '/v1/me/disclosures', { claims: ['dob', 'over18'] })).status).toBe(400);
    const d = (await call(h.app, t, 'POST', '/v1/me/disclosures', { claims: ['over18'] })).json;
    expect(d.qr.startsWith('KGOTLA1:')).toBe(true);
    const v = (await call(h.app, null, 'POST', '/v1/verify', { code: d.qr })).json;
    expect(v.valid).toBe(true);
    expect(v.claims).toEqual({ over18: true });
    expect(v.assuranceLevel).toBe(3);

    const [body, sig] = d.token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), claims: { over18: true, name: 'Someone Else' } })).toString('base64url');
    expect((await call(h.app, null, 'POST', '/v1/verify', { code: `${forged}.${sig}` })).json.valid).toBe(false);
  });

  it('time-limited document links can be opened, then revoked', async () => {
    const t = await login(h.app, NALEDI);
    const me = (await call(h.app, t, 'GET', '/v1/me')).json;
    const doc = me.documents.find((d: any) => d.type === 'omang');
    const s = (await call(h.app, t, 'POST', `/v1/me/documents/${doc.id}/share`, { hours: 24 })).json;
    const token = s.url.split('/s/')[1];
    const page = await h.app.inject({ method: 'GET', url: `/s/${token}` });
    expect(page.body).toContain('Naledi Mothibi');
    expect(page.body).toContain('***1904');
    expect(page.body).not.toContain('435721904');
    await call(h.app, t, 'DELETE', `/v1/me/shares/${s.id}`);
    expect((await h.app.inject({ method: 'GET', url: `/s/${token}` })).body).toContain('Link not available');
  });
});
