import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { localDate } from '../src/lib/time.js';
import { DpoGateway, PayPalGateway, TestGateway, type FetchLike } from '../src/modules/payments.js';
import { buildApp } from '../src/app.js';
import { balance, call, harness, login, NALEDI, type Harness } from './helpers.js';

const plus = (n: number) => new Date(Date.parse(localDate() + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10);

/** Records requests and answers from a script, like a provider's API would. */
function fakeHttp(handler: (url: string, init: any) => { status?: number; body: unknown }) {
  const calls: { url: string; init: any }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = handler(url, init);
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return { status: r.status ?? 200, ok: (r.status ?? 200) < 300, text: async () => text };
  };
  return { f, calls };
}

describe('payments with the demo test gateway', () => {
  let h: Harness;
  let naledi: string;
  beforeAll(async () => {
    h = await harness();
    naledi = await login(h.app, NALEDI);
  });
  afterAll(async () => h?.close());

  it('lists the methods this cell can take', async () => {
    const cfg = await call(h.app, null, 'GET', '/v1/config');
    expect(cfg.json.paymentMethods.map((m: any) => m.id)).toEqual(['test']); // no PayPal or DPO keys in tests
  });

  it('tops up only after the provider confirms, and only once', async () => {
    const before = await balance(h.app, naledi);
    const s = await call(h.app, naledi, 'POST', '/v1/me/payments', { provider: 'test', amount: '250.00' });
    expect(s.status).toBe(200);
    expect(s.json.redirectUrl).toContain(`/pay-test.html?payment=${s.json.paymentId}`);
    // Coming back without paying changes nothing.
    expect((await call(h.app, naledi, 'POST', `/v1/me/payments/${s.json.paymentId}/complete`)).json.status).toBe('pending');
    expect(await balance(h.app, naledi)).toBe(before);

    expect((await call(h.app, null, 'POST', `/v1/payments/test/${s.json.paymentId}/decide`, { approve: true })).status).toBe(200);
    const done = await call(h.app, naledi, 'POST', `/v1/me/payments/${s.json.paymentId}/complete`);
    expect(done.json.status).toBe('paid');
    expect(await balance(h.app, naledi)).toBe(before + 25000);
    await call(h.app, naledi, 'POST', `/v1/me/payments/${s.json.paymentId}/complete`);
    expect(await balance(h.app, naledi)).toBe(before + 25000);
  });

  it('does not credit a cancelled payment, and limits apply', async () => {
    const before = await balance(h.app, naledi);
    const s = await call(h.app, naledi, 'POST', '/v1/me/payments', { provider: 'test', amount: '100' });
    await call(h.app, null, 'POST', `/v1/payments/test/${s.json.paymentId}/decide`, { approve: false });
    expect((await call(h.app, naledi, 'POST', `/v1/me/payments/${s.json.paymentId}/complete`)).json.status).toBe('cancelled');
    expect(await balance(h.app, naledi)).toBe(before);
    expect((await call(h.app, naledi, 'POST', '/v1/me/payments', { provider: 'test', amount: '999999' })).json.error.code).toBe('limit');
    expect((await call(h.app, naledi, 'POST', '/v1/me/payments', { provider: 'paypal', amount: '100' })).json.error.code).toBe('method_unavailable');
  });

  it('pays for a booking directly: the payment stands in for the PIN', async () => {
    const before = await balance(h.app, naledi);
    const a = await call(h.app, naledi, 'POST', '/v1/actions', { type: 'book_tourism', params: { listingId: 'park-chobe', rateKey: 'international', startDate: plus(12), days: 1, quantity: 2 } });
    expect(a.json.amount).toBe(24000);
    const s = await call(h.app, naledi, 'POST', '/v1/me/payments', { provider: 'test', actionId: a.json.id });
    await call(h.app, null, 'POST', `/v1/payments/test/${s.json.paymentId}/decide`, { approve: true });
    const done = await call(h.app, naledi, 'POST', `/v1/me/payments/${s.json.paymentId}/complete`);
    expect(done.json.status).toBe('paid');
    expect(done.json.actionResult.status).toBe('done');
    expect(done.json.actionResult.message).toContain('Booked');
    expect(await balance(h.app, naledi)).toBe(before); // paid in, paid out
    expect((await call(h.app, naledi, 'GET', `/v1/actions/${a.json.id}`)).json.status).toBe('done');
    const audit = await h.pool.query(`SELECT data FROM audit_log WHERE action = 'action.book_tourism' ORDER BY id DESC LIMIT 1`);
    expect(audit.rows[0].data.confirmedWith).toBe('test');
  });

  it('the reconciler completes payments whose return trip was lost', async () => {
    const before = await balance(h.app, naledi);
    const s = await call(h.app, naledi, 'POST', '/v1/me/payments', { provider: 'test', amount: '50' });
    await call(h.app, null, 'POST', `/v1/payments/test/${s.json.paymentId}/decide`, { approve: true });
    await h.pool.query(`UPDATE external_payments SET created_at = now() - interval '5 minutes' WHERE id = $1`, [s.json.paymentId]);
    expect(await (h.app as any).reconcilePayments()).toBeGreaterThanOrEqual(1);
    expect(await balance(h.app, naledi)).toBe(before + 5000);
    const ov = await h.pool.query('SELECT COALESCE(SUM(amount),0)::bigint AS s FROM postings');
    expect(Number(ov.rows[0].s)).toBe(0);
  });

  it('someone else cannot complete or see my payment', async () => {
    const s = await call(h.app, naledi, 'POST', '/v1/me/payments', { provider: 'test', amount: '20' });
    const other = await login(h.app, { omang: '512810117', pin: '1357' });
    expect((await call(h.app, other, 'POST', `/v1/me/payments/${s.json.paymentId}/complete`)).status).toBe(404);
  });
});

describe('PayPal adapter (Orders v2)', () => {
  const opts = { clientId: 'cid', clientSecret: 'sec', env: 'sandbox' as const, currency: 'USD', fxRate: 13.5 };

  it('creates an order in USD at the set rate and sends the person to PayPal', async () => {
    const http = fakeHttp((url, init) => {
      if (url.endsWith('/v1/oauth2/token')) return { body: { access_token: 'tok', expires_in: 3600 } };
      const b = JSON.parse(init.body);
      return { status: 201, body: { id: 'ORDER1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1' }], echo: b } };
    });
    const g = new PayPalGateway(opts, http.f);
    const c = await g.create({ paymentId: 'p1', amount: 13500, currency: 'BWP', description: 'Kgotla wallet top-up P 135.00', returnUrl: 'https://k/?payment=p1', cancelUrl: 'https://k/?payment=p1&cancelled=1' });
    expect(c).toMatchObject({ providerRef: 'ORDER1', chargedAmount: 1000, chargedCurrency: 'USD' });
    expect(c.redirectUrl).toContain('sandbox.paypal.com');
    expect(http.calls[0].url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
    expect(http.calls[0].init.headers.authorization).toBe('Basic ' + Buffer.from('cid:sec').toString('base64'));
    const order = JSON.parse(http.calls[1].init.body);
    expect(order.intent).toBe('CAPTURE');
    expect(order.purchase_units[0].amount).toEqual({ currency_code: 'USD', value: '10.00' });
    expect(order.payment_source.paypal.experience_context.return_url).toBe('https://k/?payment=p1');
    expect(http.calls[1].init.headers['paypal-request-id']).toBe('kgotla-create-p1');
  });

  it('captures and reports the amount PayPal actually took', async () => {
    const ok = fakeHttp((url) =>
      url.endsWith('/token') ? { body: { access_token: 't' } } : { status: 201, body: { id: 'O', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP', status: 'COMPLETED', amount: { currency_code: 'USD', value: '10.00' } }] } }] } },
    );
    expect(await new PayPalGateway(opts, ok.f).complete('O', 'p1')).toMatchObject({ status: 'paid', chargedAmount: 1000, chargedCurrency: 'USD' });
    expect(ok.calls[1].url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders/O/capture');

    const notApproved = fakeHttp((url) => (url.endsWith('/token') ? { body: { access_token: 't' } } : { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] } }));
    expect((await new PayPalGateway(opts, notApproved.f).complete('O', 'p1')).status).toBe('pending');
  });

  it('a live app uses the live PayPal host', async () => {
    const http = fakeHttp(() => ({ body: { access_token: 't' } }));
    await new PayPalGateway({ ...opts, env: 'live' }, http.f).complete('O', 'p').catch(() => undefined);
    expect(http.calls[0].url).toBe('https://api-m.paypal.com/v1/oauth2/token');
  });
});

describe('DPO Pay adapter (API v6)', () => {
  const opts = { companyToken: 'COMPANY', serviceType: '3854', apiUrl: 'https://secure.3gdirectpay.com/API/v6/', payUrl: 'https://secure.3gdirectpay.com/payv2.php?ID=' };

  it('creates a token in local currency and verifies the result codes', async () => {
    const http = fakeHttp((_u, init) => {
      if (init.body.includes('<Request>createToken</Request>')) return { body: '<?xml version="1.0"?><API3G><Result>000</Result><ResultExplanation>Transaction created</ResultExplanation><TransToken>TT-1</TransToken><TransRef>R1</TransRef></API3G>' };
      return { body: '<API3G><Result>000</Result><ResultExplanation>Transaction Paid</ResultExplanation><TransactionAmount>135.00</TransactionAmount><TransactionCurrency>BWP</TransactionCurrency></API3G>' };
    });
    const g = new DpoGateway(opts, http.f);
    const c = await g.create({ paymentId: 'p<1>', amount: 13500, currency: 'BWP', description: 'Top-up & more', returnUrl: 'https://k/?payment=p1', cancelUrl: 'https://k/?x=1&cancelled=1' });
    expect(c).toMatchObject({ providerRef: 'TT-1', redirectUrl: 'https://secure.3gdirectpay.com/payv2.php?ID=TT-1', chargedAmount: 13500, chargedCurrency: 'BWP' });
    const xml = http.calls[0].init.body;
    expect(xml).toContain('<PaymentAmount>135.00</PaymentAmount><PaymentCurrency>BWP</PaymentCurrency>');
    expect(xml).toContain('<CompanyRef>p&lt;1&gt;</CompanyRef>');
    expect(xml).toContain('<BackURL>https://k/?x=1&amp;cancelled=1</BackURL>');
    expect(xml).toContain('<ServiceType>3854</ServiceType>');
    expect(await g.complete('TT-1')).toMatchObject({ status: 'paid', chargedAmount: 13500, chargedCurrency: 'BWP' });

    const codes = (result: string) => new DpoGateway(opts, fakeHttp(() => ({ body: `<API3G><Result>${result}</Result><ResultExplanation>x</ResultExplanation></API3G>` })).f).complete('T');
    expect((await codes('900')).status).toBe('pending');
    expect((await codes('904')).status).toBe('cancelled');
    expect((await codes('901')).status).toBe('failed');
  });

  it('refuses to credit when the provider took a different amount', async () => {
    const h = await harness();
    try {
      // A gateway that claims success for the wrong amount.
      const liar = { id: 'dpo' as const, name: 'DPO', description: '', create: async () => ({ providerRef: 'X', redirectUrl: 'https://x', chargedAmount: 10000, chargedCurrency: 'BWP' }), complete: async () => ({ status: 'paid' as const, chargedAmount: 100, chargedCurrency: 'BWP' }) };
      const app = await buildApp({ pool: h.pool, gateways: [liar, new TestGateway(h.pool)] });
      const t = await login(app, NALEDI);
      const before = await balance(app, t);
      const s = await call(app, t, 'POST', '/v1/me/payments', { provider: 'dpo', amount: '100' });
      const r = await call(app, t, 'POST', `/v1/me/payments/${s.json.paymentId}/complete`);
      expect(r.json.status).toBe('failed');
      expect(r.json.error).toContain('mismatch');
      expect(await balance(app, t)).toBe(before);
      await app.close();
    } finally {
      await h.close();
    }
  });
});

describe('open sign-up (live mode without a registry link)', () => {
  let h: Harness;
  beforeAll(async () => {
    config.registryMode = 'open';
    h = await harness();
  });
  afterAll(async () => {
    config.registryMode = 'mock';
    await h?.close();
  });

  it('signs up with declared details and SMS, at assurance level 2', async () => {
    const cfg = await call(h.app, null, 'GET', '/v1/config');
    expect(cfg.json.enrolment).toBe('open');
    expect((await call(h.app, null, 'POST', '/v1/enrol/start', { nationalId: '123456789' })).json.error.code).toBe('details_required');
    const s = await call(h.app, null, 'POST', '/v1/enrol/start', { nationalId: '123456789', firstName: 'Boitumelo', lastName: 'Sechele', dob: '1994-03-02', phone: '75 123 456', district: 'Francistown' });
    expect(s.status).toBe(200);
    expect(s.json.phoneMasked).toContain('+267 75');
    // Messages go to the number the person typed.
    const sms = await h.pool.query(`SELECT payload FROM outbox WHERE topic = 'sms.phone' ORDER BY id DESC LIMIT 1`);
    expect(sms.rows[0].payload.phone).toBe('+26775123456');
    await call(h.app, null, 'POST', `/v1/enrol/${s.json.enrolmentId}/otp`, { code: s.json.demoOtp });
    const face = await call(h.app, null, 'POST', `/v1/enrol/${s.json.enrolmentId}/liveness`, { selfie: 'data:image/jpeg;base64,' + Buffer.alloc(4000, 7).toString('base64') });
    expect(face.json.passed).toBe(true);
    const done = await call(h.app, null, 'POST', `/v1/enrol/${s.json.enrolmentId}/complete`, { pin: '4826' });
    expect(done.status).toBe(200);
    const me = await call(h.app, done.json.token, 'GET', '/v1/me');
    expect(me.json.profile).toMatchObject({ firstName: 'Boitumelo', loa: 2, district: 'Francistown' });
    expect(me.json.documents.some((d: any) => d.type === 'omang')).toBe(false); // no ID credential without verification

    // Wallet, payments and tourism work; government services wait for verification.
    const tax = await call(h.app, done.json.token, 'POST', '/v1/actions', { type: 'tax_clearance', params: {} });
    expect(tax.json.error.code).toBe('verification_required');
    // The same phone cannot open a second account.
    expect((await call(h.app, null, 'POST', '/v1/enrol/start', { nationalId: '223456789', firstName: 'A', lastName: 'B', dob: '1990-01-01', phone: '75123456' })).json.error.code).toBe('phone_in_use');
    // Too young.
    expect((await call(h.app, null, 'POST', '/v1/enrol/start', { nationalId: '323456789', firstName: 'A', lastName: 'B', dob: plus(-365 * 10), phone: '75123499' })).json.error.code).toBe('invalid_dob');
  });
});
