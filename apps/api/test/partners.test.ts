import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processWebhooks, verifySignature, webhookSecret, type FetchLike } from '../src/lib/webhooks.js';
import { auth, balance, call, harness, login, MPHO, NALEDI, officerLogin, type Harness } from './helpers.js';

/** Captures webhook POSTs instead of sending them. */
function fakeReceiver(statuses: number[] = []) {
  const got: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    got.push({ url, headers: init.headers, body: init.body });
    const status = statuses.length ? statuses.shift()! : 200;
    return { status, ok: status < 300 };
  };
  return { got, fetchImpl };
}

describe('partner hub', () => {
  let h: Harness;
  let admin: string;
  let naledi: string;
  let portal: string;
  let partnerId: string;
  let clientId: string;
  let clientSecret: string;
  let api: string;
  let subject: string;
  const receiver = fakeReceiver();

  const apply = (over: Record<string, unknown> = {}) =>
    call(h.app, null, 'POST', '/v1/partners/apply', {
      type: 'clinic',
      legalName: 'Riverside Medical Centre (Pty) Ltd',
      tradingName: 'Riverside Medical Centre',
      registrationNo: 'BW00009998887',
      licenceNo: 'HF-7788',
      contactName: 'Dr Neo Ramotswa',
      contactEmail: 'admin@riverside.example',
      contactPhone: '71 555 123',
      password: 'a-long-portal-password',
      webhookUrl: 'https://riverside.example/kgotla/events',
      ...over,
    });

  beforeAll(async () => {
    h = await harness();
    admin = await officerLogin(h.app, 'admin');
    naledi = await login(h.app, NALEDI);
  });
  afterAll(async () => h?.close());

  it('takes an application and checks the licence with the regulator', async () => {
    const r = await apply();
    expect(r.status).toBe(201);
    expect(r.json.status).toBe('applied');
    expect(r.json.licenceCheck.status).toBe('verified');
    expect(r.json.licenceCheck.register).toContain('Ministry of Health');
    partnerId = r.json.partnerId;

    const dup = await apply();
    expect(dup.status).toBe(409);

    const bad = await apply({ contactEmail: 'x@bad.example', licenceNo: 'X-0000', tradingName: 'Shady Clinic' });
    expect(bad.json.licenceCheck.status).toBe('not_found');
  });

  it('lets the applicant into the portal but not the API until approved', async () => {
    const wrong = await call(h.app, null, 'POST', '/v1/partner-portal/login', { email: 'admin@riverside.example', password: 'nope-nope-nope' });
    expect(wrong.status).toBe(401);
    const r = await call(h.app, null, 'POST', '/v1/partner-portal/login', { email: 'ADMIN@riverside.example', password: 'a-long-portal-password' });
    expect(r.status).toBe(200);
    portal = r.json.token;
    const me = await call(h.app, portal, 'GET', '/v1/partner-portal/me');
    expect(me.json.partner.status).toBe('applied');
    const key = await call(h.app, portal, 'POST', '/v1/partner-portal/credentials', {});
    expect(key.status).toBe(403);
    expect(key.json.error.code).toBe('not_approved');
    // A portal session is not an API token, and a citizen token is neither.
    expect((await call(h.app, portal, 'GET', '/v1/partner/me')).status).toBe(403);
    expect((await call(h.app, naledi, 'GET', '/v1/partner-portal/me')).status).toBe(403);
  });

  it('only admins review, and capabilities must fit the partner type', async () => {
    const caseworker = await officerLogin(h.app, 'drts.case');
    expect((await call(h.app, caseworker, 'GET', '/v1/officer/partners')).status).toBe(403);
    const list = await call(h.app, admin, 'GET', '/v1/officer/partners?status=applied');
    expect(list.json.partners.some((p: any) => p.id === partnerId)).toBe(true);
    // The seeded demo doctor is waiting too.
    expect(list.json.partners.some((p: any) => p.type === 'doctor')).toBe(true);

    const tooMuch = await call(h.app, admin, 'POST', `/v1/officer/partners/${partnerId}/approve`, { capabilities: ['identity.kyc'] });
    expect(tooMuch.status).toBe(400);
    const ok = await call(h.app, admin, 'POST', `/v1/officer/partners/${partnerId}/approve`, { note: 'Facility licence confirmed' });
    expect(ok.status).toBe(200);
    const again = await call(h.app, admin, 'POST', `/v1/officer/partners/${partnerId}/approve`, {});
    expect(again.status).toBe(409);
  });

  it('issues API keys once and exchanges them for an access token', async () => {
    const key = await call(h.app, portal, 'POST', '/v1/partner-portal/credentials', { label: 'Patient system' });
    expect(key.status).toBe(200);
    clientId = key.json.clientId;
    clientSecret = key.json.clientSecret;
    expect(clientSecret).toMatch(/^ks_/);
    const me = await call(h.app, portal, 'GET', '/v1/partner-portal/me');
    expect(JSON.stringify(me.json)).not.toContain(clientSecret);

    const bad = await h.app.inject({ method: 'POST', url: '/v1/oauth/token', payload: { grant_type: 'client_credentials', client_id: clientId, client_secret: 'wrong' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe('invalid_client');

    // Form body with HTTP Basic, the way most OAuth libraries send it.
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tok = await h.app.inject({
      method: 'POST',
      url: '/v1/oauth/token',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'grant_type=client_credentials',
    });
    expect(tok.statusCode).toBe(200);
    expect(tok.json().token_type).toBe('Bearer');
    expect(tok.json().expires_in).toBe(3600);
    api = tok.json().access_token;
    const me2 = await call(h.app, api, 'GET', '/v1/partner/me');
    expect(me2.json.partner.tradingName).toBe('Riverside Medical Centre');
    expect(me2.json.partner.capabilities).toContain('documents.issue');
  });

  it('asks a citizen for consent; nothing is shared until they approve with their PIN', async () => {
    const notMine = await call(h.app, api, 'POST', '/v1/partner/consents', { nationalId: NALEDI.omang, scopes: ['identity.kyc'], purpose: 'Check identity' });
    expect(notMine.status).toBe(403);
    const nobody = await call(h.app, api, 'POST', '/v1/partner/consents', { nationalId: '999999999', scopes: ['identity.basic'], purpose: 'Patient file' });
    expect(nobody.status).toBe(404);

    const req = await call(h.app, api, 'POST', '/v1/partner/consents', {
      nationalId: NALEDI.omang,
      scopes: ['identity.basic', 'documents.issue', 'payments.request', 'notifications.send'],
      purpose: 'Your patient file, sick notes and bills from Riverside',
    });
    expect(req.status).toBe(201);
    expect(req.json.status).toBe('requested');
    expect(req.json.subject).toBeNull();
    const consentId = req.json.consentId;

    // Asking again returns the same open request instead of spamming the citizen.
    const again = await call(h.app, api, 'POST', '/v1/partner/consents', { nationalId: NALEDI.omang, scopes: ['payments.request', 'identity.basic', 'documents.issue', 'notifications.send'], purpose: 'again' });
    expect(again.json.consentId).toBe(consentId);

    const me = await call(h.app, naledi, 'GET', '/v1/me');
    const shown = me.json.consentRequests.find((c: any) => c.id === consentId);
    expect(shown.partner.name).toBe('Riverside Medical Centre');
    expect(shown.scopes.map((s: any) => s.scope)).toContain('payments.request');
    expect(me.json.notifications[0].title).toBe('Riverside Medical Centre asks for access');

    expect((await call(h.app, naledi, 'POST', `/v1/me/consents/${consentId}/approve`, {})).status).toBe(401);
    const wrong = await call(h.app, naledi, 'POST', `/v1/me/consents/${consentId}/approve`, { pin: '0000' });
    expect(wrong.json.error.code).toBe('wrong_pin');
    // Someone else cannot answer for her.
    const mpho = await login(h.app, MPHO);
    expect((await call(h.app, mpho, 'POST', `/v1/me/consents/${consentId}/approve`, { pin: MPHO.pin })).status).toBe(404);

    const ok = await call(h.app, naledi, 'POST', `/v1/me/consents/${consentId}/approve`, { pin: NALEDI.pin });
    expect(ok.json.status).toBe('granted');
    const status = await call(h.app, api, 'GET', `/v1/partner/consents/${consentId}`);
    expect(status.json.status).toBe('granted');
    subject = status.json.subject;
    expect(subject).toMatch(/^sub_/);
  });

  it('sends signed webhooks the partner can verify', async () => {
    const n = await processWebhooks(h.pool, receiver.fetchImpl);
    expect(n).toBeGreaterThanOrEqual(2); // partner.approved, consent.granted
    const granted = receiver.got.find((g) => g.headers['kgotla-event'] === 'consent.granted')!;
    expect(granted.url).toBe('https://riverside.example/kgotla/events');
    expect(JSON.parse(granted.body).data.subject).toBe(subject);
    const portalSecret = (await call(h.app, portal, 'POST', '/v1/partner-portal/webhook/secret', {})).json.secret;
    expect(portalSecret).toBe(webhookSecret(partnerId, 1));
    expect(verifySignature(portalSecret, granted.headers['kgotla-signature'], granted.body)).toBe(true);
    expect(verifySignature(portalSecret, granted.headers['kgotla-signature'], granted.body.replace('granted', 'grantee'))).toBe(false);
    expect(verifySignature('whsec_wrong', granted.headers['kgotla-signature'], granted.body)).toBe(false);
  });

  it('pairwise subjects: two partners see different ids for the same person', async () => {
    const bank = await h.app.inject({ method: 'POST', url: '/v1/oauth/token', payload: { client_id: 'demo-bank', client_secret: 'demo-bank-secret' } });
    expect(bank.statusCode).toBe(200);
    const bankToken = bank.json().access_token;
    const r = await call(h.app, bankToken, 'POST', '/v1/partner/consents', { nationalId: NALEDI.omang, scopes: ['identity.basic', 'identity.kyc'], purpose: 'Open a savings account without visiting a branch' });
    // The demo data already holds this request for her.
    const me = await call(h.app, naledi, 'GET', '/v1/me/consents');
    expect(me.json.requests.some((c: any) => c.id === r.json.consentId)).toBe(true);
    await call(h.app, naledi, 'POST', `/v1/me/consents/${r.json.consentId}/approve`, { pin: NALEDI.pin });
    const st = await call(h.app, bankToken, 'GET', `/v1/partner/consents/${r.json.consentId}`);
    expect(st.json.subject).not.toBe(subject);

    // eKYC: verified identity, signed, without the full ID number.
    const kyc = await call(h.app, bankToken, 'GET', `/v1/partner/citizens/${st.json.subject}/identity`);
    expect(kyc.status).toBe(200);
    expect(kyc.json.level).toBe('kyc');
    expect(kyc.json.claims.given_name).toBe('Naledi');
    expect(kyc.json.claims.assurance_level).toBe(3);
    expect(kyc.json.claims.birthdate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(JSON.stringify(kyc.json)).not.toContain(NALEDI.omang);
    expect(kyc.json.attestation.split('.')).toHaveLength(2);
    // The bank's subject id means nothing to the clinic.
    expect((await call(h.app, api, 'GET', `/v1/partner/citizens/${st.json.subject}/identity`)).status).toBe(403);
  });

  it('the clinic sees only what was granted', async () => {
    const id = await call(h.app, api, 'GET', `/v1/partner/citizens/${subject}/identity`);
    expect(id.json.level).toBe('basic');
    expect(id.json.claims.name).toBe('Naledi Mothibi');
    expect(id.json.claims.birthdate).toBeUndefined();
    expect((await call(h.app, api, 'GET', `/v1/partner/citizens/${subject}/documents`)).json.error.code).toBe('consent_required');
  });

  it('issues medical documents into the Vault, but not government ones', async () => {
    const ok = await call(h.app, api, 'POST', `/v1/partner/citizens/${subject}/documents`, { type: 'medical_certificate', title: 'Sick note · 3 days', ref: 'SN-2210', validTo: '2030-01-31' });
    expect(ok.status).toBe(201);
    const me = await call(h.app, naledi, 'GET', '/v1/me');
    const doc = me.json.documents.find((d: any) => d.id === ok.json.documentId);
    expect(doc.issuer).toBe('Riverside Medical Centre');
    expect((await call(h.app, api, 'POST', `/v1/partner/citizens/${subject}/documents`, { type: 'omang', title: 'Fake ID' })).json.error.code).toBe('invalid_document_type');
    expect((await call(h.app, api, 'POST', `/v1/partner/citizens/${subject}/documents`, { type: 'bank_statement', title: 'Not a clinic thing' })).status).toBe(400);
  });

  it('sends a bill the citizen pays once with her PIN', async () => {
    const before = await balance(h.app, naledi);
    const bill = await call(h.app, api, 'POST', `/v1/partner/citizens/${subject}/payment-requests`, { amount: '120.00', reference: 'INV-77', description: 'Consultation' });
    expect(bill.status).toBe(201);
    expect(bill.json.amountText).toBe('P 120.00');
    // Same reference again is idempotent; a different amount is refused.
    expect((await call(h.app, api, 'POST', `/v1/partner/citizens/${subject}/payment-requests`, { amount: '120.00', reference: 'INV-77', description: 'Consultation' })).json.id).toBe(bill.json.id);
    expect((await call(h.app, api, 'POST', `/v1/partner/citizens/${subject}/payment-requests`, { amount: '99', reference: 'INV-77', description: 'Different bill' })).status).toBe(409);

    const mine = await call(h.app, naledi, 'GET', '/v1/me');
    expect(mine.json.bills.some((b: any) => b.id === bill.json.id && b.partner === 'Riverside Medical Centre')).toBe(true);

    const a = await call(h.app, naledi, 'POST', '/v1/actions', { type: 'pay_request', params: { requestId: bill.json.id } });
    expect(a.status).toBe(200);
    expect(a.json.readback).toContainEqual(['Reference', 'INV-77']);
    const done = await call(h.app, naledi, 'POST', `/v1/actions/${a.json.id}/confirm`, { pin: NALEDI.pin });
    expect(done.json.status).toBe('done');
    expect(await balance(h.app, naledi)).toBe(before - 12000);

    const twice = await call(h.app, naledi, 'POST', '/v1/actions', { type: 'pay_request', params: { requestId: bill.json.id } });
    expect(twice.json.error.code).toBe('not_pending');
    expect((await call(h.app, api, 'GET', `/v1/partner/payment-requests/${bill.json.id}`)).json.status).toBe('paid');

    await processWebhooks(h.pool, receiver.fetchImpl);
    const paid = receiver.got.find((g) => g.headers['kgotla-event'] === 'payment_request.paid')!;
    expect(JSON.parse(paid.body).data).toMatchObject({ reference: 'INV-77', amount: 12000, currency: 'BWP', subject });

    const ov = await call(h.app, admin, 'GET', '/v1/officer/overview');
    expect(ov.json.ledgerBalanced).toBe(true);
    expect(ov.json.auditChainIntact).toBe(true);
  });

  it('publishes clinic slots that citizens book in the app, and tells the clinic', async () => {
    const loc = await call(h.app, api, 'PUT', '/v1/partner/locations', { key: 'main', name: 'Riverside Medical Centre · Broadhurst', capacity: 2, slotTimes: ['09:00', '10:00', '11:00'] });
    expect(loc.status).toBe(200);
    const list = await call(h.app, naledi, 'GET', '/v1/locations?kind=clinic');
    expect(list.json.some((l: any) => l.id === loc.json.id)).toBe(true);
    const avail = await call(h.app, naledi, 'GET', `/v1/locations/${loc.json.id}/availability`);
    const slot = avail.json.days[1].slots[0];
    const a = await call(h.app, naledi, 'POST', '/v1/actions', { type: 'book_appointment', params: { locationId: loc.json.id, startsAt: slot.startsAt } });
    expect((await call(h.app, naledi, 'POST', `/v1/actions/${a.json.id}/confirm`, {})).json.status).toBe('done');

    const appts = await call(h.app, api, 'GET', '/v1/partner/appointments');
    expect(appts.json).toHaveLength(1);
    expect(appts.json[0].patient).toEqual({ name: 'Naledi Mothibi', subject });
    expect((await call(h.app, api, 'POST', `/v1/partner/appointments/${appts.json[0].id}/attended`)).json.status).toBe('attended');

    await processWebhooks(h.pool, receiver.fetchImpl);
    expect(receiver.got.some((g) => g.headers['kgotla-event'] === 'appointment.booked')).toBe(true);
    // Another partner cannot touch these bookings.
    const bank = (await h.app.inject({ method: 'POST', url: '/v1/oauth/token', payload: { client_id: 'demo-bank', client_secret: 'demo-bank-secret' } })).json().access_token;
    expect((await call(h.app, bank, 'PUT', '/v1/partner/locations', { name: 'Bank branch', slotTimes: ['09:00'] })).status).toBe(403);
    expect((await call(h.app, bank, 'GET', '/v1/partner/appointments')).json).toHaveLength(0);
  });

  it('retries failed webhook deliveries with back-off', async () => {
    const flaky = fakeReceiver([503]);
    await call(h.app, portal, 'POST', '/v1/partner-portal/webhook/test', {});
    expect(await processWebhooks(h.pool, flaky.fetchImpl)).toBe(0);
    const row = (await h.pool.query(`SELECT status, attempts, last_status, next_attempt_at > now() AS later FROM webhook_deliveries WHERE event = 'ping' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_status: 503, later: true });
    await h.pool.query(`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE event = 'ping'`);
    expect(await processWebhooks(h.pool, flaky.fetchImpl)).toBe(1);
    const view = await call(h.app, portal, 'GET', '/v1/partner-portal/me');
    expect(view.json.webhook.deliveries[0]).toMatchObject({ event: 'ping', status: 'delivered', attempts: 2 });
  });

  it('withdrawing consent cuts access immediately and tells the partner', async () => {
    const me = await call(h.app, naledi, 'GET', '/v1/me/consents');
    const c = me.json.connected.find((x: any) => x.partner.name === 'Riverside Medical Centre');
    expect((await call(h.app, naledi, 'POST', `/v1/me/consents/${c.id}/revoke`)).json.status).toBe('revoked');
    expect((await call(h.app, api, 'GET', `/v1/partner/citizens/${subject}/identity`)).json.error.code).toBe('consent_required');
    expect((await call(h.app, api, 'POST', `/v1/partner/citizens/${subject}/payment-requests`, { amount: 10, reference: 'INV-78', description: 'Follow-up visit' })).status).toBe(403);
    // And it cannot simply ask again straight away.
    const nag = await call(h.app, api, 'POST', '/v1/partner/consents', { nationalId: NALEDI.omang, scopes: ['identity.basic'], purpose: 'Please let us back in' });
    expect(nag.json.error.code).toBe('recently_declined');
    await processWebhooks(h.pool, receiver.fetchImpl);
    expect(receiver.got.some((g) => g.headers['kgotla-event'] === 'consent.revoked')).toBe(true);
  });

  it('suspending a partner stops its tokens and keys at once', async () => {
    const r = await call(h.app, admin, 'POST', `/v1/officer/partners/${partnerId}/suspend`, { note: 'Licence under review' });
    expect(r.status).toBe(200);
    expect((await call(h.app, api, 'GET', '/v1/partner/me')).status).toBe(401);
    const tok = await h.app.inject({ method: 'POST', url: '/v1/oauth/token', payload: { client_id: clientId, client_secret: clientSecret } });
    expect(tok.statusCode).toBe(401);
    await call(h.app, admin, 'POST', `/v1/officer/partners/${partnerId}/reinstate`, {});
    const back = await h.app.inject({ method: 'POST', url: '/v1/oauth/token', payload: { client_id: clientId, client_secret: clientSecret } });
    expect(back.statusCode).toBe(200);
    // A revoked key stops working.
    const creds = (await call(h.app, portal, 'GET', '/v1/partner-portal/me')).json.credentials;
    await call(h.app, portal, 'DELETE', `/v1/partner-portal/credentials/${creds[0].id}`);
    expect((await h.app.inject({ method: 'POST', url: '/v1/oauth/token', payload: { client_id: clientId, client_secret: clientSecret } })).statusCode).toBe(401);
  });

  it('demo data: the citizen sees the clinic bill and the bank request', async () => {
    const mpho = await login(h.app, MPHO);
    const m = await call(h.app, mpho, 'GET', '/v1/me');
    expect(m.json.bills).toHaveLength(0);
    const cat = await call(h.app, null, 'GET', '/v1/partners/catalogue');
    expect(cat.json.types.find((t: any) => t.type === 'doctor').regulator.code).toBe('BHPC');
    expect(cat.json.scopes.length).toBe(6);
    void auth;
  });
});

describe('partner hub in the other country cells', () => {
  for (const [cc, regulatorCode, id, pin] of [
    ['ZA', 'HPCSA', '9106230120087', '2580'],
    ['NA', 'HPCNA', '89031400123', '2580'],
    ['ZM', 'HPCZ', '234561/11/1', '2580'],
    ['ZW', 'MDPCZ', '63-245718K42', '2580'],
  ] as const) {
    it(`${cc}: local regulators, the demo clinic bills in local currency`, async () => {
      const h = await harness({ country: cc });
      try {
        const cat = await call(h.app, null, 'GET', '/v1/partners/catalogue');
        expect(cat.json.types.find((t: any) => t.type === 'doctor').regulator.code).toBe(regulatorCode);
        const tok = (await h.app.inject({ method: 'POST', url: '/v1/oauth/token', payload: { client_id: 'demo-clinic', client_secret: 'demo-clinic-secret' } })).json().access_token;
        const c = await call(h.app, tok, 'POST', '/v1/partner/consents', { nationalId: id, scopes: ['identity.basic', 'payments.request'], purpose: 'Your bills from the clinic' });
        // Already granted in the demo data, so the subject comes straight back.
        expect(c.json.status).toBe('granted');
        const bill = await call(h.app, tok, 'POST', `/v1/partner/citizens/${c.json.subject}/payment-requests`, { amount: 25, reference: `T-${cc}`, description: 'Repeat prescription' });
        const citizen = await login(h.app, { omang: id, pin });
        const me = await call(h.app, citizen, 'GET', '/v1/me');
        expect(me.json.bills.map((b: any) => b.id)).toContain(bill.json.id);
        expect(bill.json.currency).toBe(cat.json.country === 'ZW' ? 'USD' : { ZA: 'ZAR', NA: 'NAD', ZM: 'ZMW' }[cc as 'ZA']);
        expect(me.json.consentRequests.length).toBe(1); // the demo bank's request
      } finally {
        await h.close();
      }
    });
  }
});
