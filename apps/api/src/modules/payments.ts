import type pg from 'pg';
import { z } from 'zod';
import { config } from '../config.js';
import { country } from '../countries/index.js';
import { many, one, tx, type Queryable } from '../db.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { fmt, toThebe } from '../lib/money.js';
import { notify } from '../lib/notify.js';
import { ensureAccount, post, walletCode } from './ledger.js';

/**
 * Money in from outside Kgotla.
 *
 *   PayPal   Orders API v2: PayPal account or card, charged in USD (PayPal does
 *            not settle in BWP, ZAR, NAD or ZMW), converted at a set rate.
 *   DPO Pay  Cards and mobile money in the local currency, through DPO's
 *            hosted payment page (API v6).
 *   test     Demo cells only: a clearly-marked test checkout, no real money.
 *
 * Flow: create a checkout, send the person to the provider, and when they come
 * back (or when the reconciler notices) confirm the payment *with the provider*
 * before crediting the wallet. A payment can also pay a prepared action (a
 * booking, a bill) straight away; approving at PayPal or DPO stands in for the
 * PIN because the person authenticated with the payment provider.
 */

export type ProviderId = 'paypal' | 'dpo' | 'test';
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export interface Checkout { providerRef: string; redirectUrl: string; chargedAmount: number; chargedCurrency: string }
export interface Outcome { status: 'paid' | 'pending' | 'failed' | 'cancelled'; chargedAmount?: number; chargedCurrency?: string; detail?: string; state?: Record<string, unknown> }

export interface Gateway {
  id: ProviderId;
  name: string;
  description: string;
  create(p: { paymentId: string; amount: number; currency: string; description: string; returnUrl: string; cancelUrl: string }): Promise<Checkout>;
  /** Ask the provider what happened. Must be safe to call more than once. */
  complete(providerRef: string, paymentId: string): Promise<Outcome>;
}

/** Local currency units per 1 USD, used for PayPal when PAYPAL_FX_RATE is not set. Rough defaults: set the real rate. */
const DEFAULT_USD_RATE: Record<string, number> = { BWP: 13.5, ZAR: 18, NAD: 18, ZMW: 26, USD: 1 };

const minorToDecimal = (n: number) => (n / 100).toFixed(2);
const decimalToMinor = (s: string) => Math.round(Number(s) * 100);

// ---------------------------------------------------------------------------
// PayPal (Orders v2)
// ---------------------------------------------------------------------------

export class PayPalGateway implements Gateway {
  id = 'paypal' as const;
  name = 'PayPal';
  description = 'PayPal balance or card';
  private token: { value: string; expires: number } | null = null;
  constructor(
    private opts: { clientId: string; clientSecret: string; env: 'sandbox' | 'live'; currency: string; fxRate: number },
    private fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}
  private get base() {
    return this.opts.env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const r = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15000),
    });
    const j = JSON.parse(await r.text());
    if (!r.ok || !j.access_token) throw new AppError(502, 'paypal_unavailable', 'PayPal is not available right now. Try again or use another method.');
    this.token = { value: j.access_token, expires: Date.now() + (j.expires_in ?? 300) * 1000 };
    return j.access_token;
  }
  private async call(path: string, body: unknown, requestId: string) {
    const r = await this.fetchImpl(`${this.base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json', 'paypal-request-id': requestId, prefer: 'return=representation' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    return { status: r.status, ok: r.ok, json: text ? JSON.parse(text) : {} };
  }
  /** Local minor units → PayPal currency minor units, rounded up so Kgotla is never short. */
  convert(amount: number, currency: string) {
    if (currency === this.opts.currency) return amount;
    const rate = this.opts.fxRate || DEFAULT_USD_RATE[currency];
    if (!rate) throw badRequest('unsupported_currency', `PayPal cannot charge ${currency} here`);
    return Math.ceil(amount / rate);
  }
  async create(p: Parameters<Gateway['create']>[0]): Promise<Checkout> {
    const charged = this.convert(p.amount, p.currency);
    const r = await this.call(
      '/v2/checkout/orders',
      {
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: p.paymentId, custom_id: p.paymentId, description: p.description.slice(0, 127), amount: { currency_code: this.opts.currency, value: minorToDecimal(charged) } }],
        payment_source: { paypal: { experience_context: { brand_name: 'Kgotla', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', return_url: p.returnUrl, cancel_url: p.cancelUrl } } },
      },
      `kgotla-create-${p.paymentId}`,
    );
    const link = (r.json.links ?? []).find((l: any) => l.rel === 'payer-action' || l.rel === 'approve');
    if (!r.ok || !r.json.id || !link) throw new AppError(502, 'paypal_error', `PayPal did not accept the payment${r.json.message ? `: ${r.json.message}` : ''}`);
    return { providerRef: r.json.id, redirectUrl: link.href, chargedAmount: charged, chargedCurrency: this.opts.currency };
  }
  async complete(orderId: string, paymentId: string): Promise<Outcome> {
    const r = await this.call(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, `kgotla-capture-${paymentId}`);
    // Already captured (a retry, or the reconciler got there first): read the order instead.
    const order = r.ok ? r.json : r.json?.details?.some((d: any) => d.issue === 'ORDER_ALREADY_CAPTURED') ? await this.getOrder(orderId) : null;
    if (!order) {
      const issue = r.json?.details?.[0]?.issue ?? r.json?.name ?? `HTTP ${r.status}`;
      if (issue === 'ORDER_NOT_APPROVED' || issue === 'PAYER_ACTION_REQUIRED') return { status: 'pending', detail: issue };
      return { status: 'failed', detail: issue };
    }
    const cap = order.purchase_units?.[0]?.payments?.captures?.[0];
    if (order.status === 'COMPLETED' && cap && cap.status === 'COMPLETED') {
      return { status: 'paid', chargedAmount: decimalToMinor(cap.amount.value), chargedCurrency: cap.amount.currency_code, state: { captureId: cap.id } };
    }
    if (cap && cap.status === 'PENDING') return { status: 'pending', detail: cap.status_details?.reason ?? 'PENDING' };
    return { status: 'failed', detail: order.status ?? 'unknown' };
  }
  private async getOrder(orderId: string) {
    const r = await this.fetchImpl(`${this.base}/v2/checkout/orders/${encodeURIComponent(orderId)}`, { method: 'GET', headers: { authorization: `Bearer ${await this.accessToken()}` }, signal: AbortSignal.timeout(15000) });
    return r.ok ? JSON.parse(await r.text()) : null;
  }
}

// ---------------------------------------------------------------------------
// DPO Pay (API v6, XML): cards and mobile money in local currency
// ---------------------------------------------------------------------------

const xmlEsc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
const tag = (xml: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1]?.trim() ?? '';

export class DpoGateway implements Gateway {
  id = 'dpo' as const;
  name = 'Card or mobile money';
  description = 'Visa, Mastercard and mobile money through DPO Pay';
  constructor(
    private opts: { companyToken: string; serviceType: string; apiUrl: string; payUrl: string },
    private fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}
  private async api(xml: string) {
    const r = await this.fetchImpl(this.opts.apiUrl, { method: 'POST', headers: { 'content-type': 'application/xml' }, body: `<?xml version="1.0" encoding="utf-8"?>${xml}`, signal: AbortSignal.timeout(20000) });
    return r.text();
  }
  async create(p: Parameters<Gateway['create']>[0]): Promise<Checkout> {
    const now = new Date();
    const date = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${String(now.getUTCDate()).padStart(2, '0')} ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
    const res = await this.api(
      `<API3G><CompanyToken>${xmlEsc(this.opts.companyToken)}</CompanyToken><Request>createToken</Request>` +
        `<Transaction><PaymentAmount>${minorToDecimal(p.amount)}</PaymentAmount><PaymentCurrency>${xmlEsc(p.currency)}</PaymentCurrency>` +
        `<CompanyRef>${xmlEsc(p.paymentId)}</CompanyRef><RedirectURL>${xmlEsc(p.returnUrl)}</RedirectURL><BackURL>${xmlEsc(p.cancelUrl)}</BackURL>` +
        `<CompanyRefUnique>1</CompanyRefUnique><PTL>60</PTL></Transaction>` +
        `<Services><Service><ServiceType>${xmlEsc(this.opts.serviceType)}</ServiceType><ServiceDescription>${xmlEsc(p.description.slice(0, 100))}</ServiceDescription><ServiceDate>${date}</ServiceDate></Service></Services></API3G>`,
    );
    const token = tag(res, 'TransToken');
    if (tag(res, 'Result') !== '000' || !token) throw new AppError(502, 'dpo_error', `The card and mobile-money service did not accept the payment${tag(res, 'ResultExplanation') ? `: ${tag(res, 'ResultExplanation')}` : ''}`);
    return { providerRef: token, redirectUrl: `${this.opts.payUrl}${encodeURIComponent(token)}`, chargedAmount: p.amount, chargedCurrency: p.currency };
  }
  async complete(token: string): Promise<Outcome> {
    const res = await this.api(`<API3G><CompanyToken>${xmlEsc(this.opts.companyToken)}</CompanyToken><Request>verifyToken</Request><TransactionToken>${xmlEsc(token)}</TransactionToken></API3G>`);
    const result = tag(res, 'Result');
    const amount = tag(res, 'TransactionAmount');
    const currency = tag(res, 'TransactionCurrency');
    // 000 paid; 900 not paid yet; 901 declined; 902 data mismatch; 903 expired; 904 cancelled.
    if (result === '000') return { status: 'paid', chargedAmount: amount ? decimalToMinor(amount) : undefined, chargedCurrency: currency || undefined, state: { approval: tag(res, 'TransactionApproval') } };
    if (result === '900') return { status: 'pending', detail: tag(res, 'ResultExplanation') };
    if (result === '904') return { status: 'cancelled', detail: tag(res, 'ResultExplanation') };
    return { status: 'failed', detail: `${result} ${tag(res, 'ResultExplanation')}`.trim() };
  }
}

// ---------------------------------------------------------------------------
// Test gateway (demo cells only)
// ---------------------------------------------------------------------------

export class TestGateway implements Gateway {
  id = 'test' as const;
  name = 'Test payment';
  description = 'Demo only. No real money moves.';
  constructor(private pool: pg.Pool) {}
  async create(p: Parameters<Gateway['create']>[0]): Promise<Checkout> {
    return { providerRef: `test_${p.paymentId}`, redirectUrl: `${config.publicBaseUrl}/pay-test.html?payment=${p.paymentId}`, chargedAmount: p.amount, chargedCurrency: p.currency };
  }
  async complete(_ref: string, paymentId: string): Promise<Outcome> {
    const r = await one<any>(this.pool, 'SELECT provider_state, amount, currency FROM external_payments WHERE id = $1', [paymentId]);
    const decision = r?.provider_state?.testDecision;
    if (decision === 'approve') return { status: 'paid', chargedAmount: Number(r.amount), chargedCurrency: r.currency };
    if (decision === 'cancel') return { status: 'cancelled' };
    return { status: 'pending' };
  }
}

/** The gateways this cell can use, from its configuration. */
export function configuredGateways(pool: pg.Pool, fetchImpl?: FetchLike): Gateway[] {
  const out: Gateway[] = [];
  const cur = country().currency.code;
  if (config.paypal.clientId && config.paypal.clientSecret) out.push(new PayPalGateway({ ...config.paypal, fxRate: config.paypal.fxRate || DEFAULT_USD_RATE[cur] }, fetchImpl));
  if (config.dpo.companyToken && config.dpo.serviceType) out.push(new DpoGateway(config.dpo, fetchImpl));
  if (config.demoMode) out.push(new TestGateway(pool));
  return out;
}

export const methodsView = (gateways: Gateway[]) =>
  gateways.map((g) => ({ id: g.id, name: g.name, description: g.description, test: g.id === 'test' || (g.id === 'paypal' && config.paypal.env === 'sandbox') }));

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

export const startSchema = z.object({
  provider: z.enum(['paypal', 'dpo', 'test']),
  amount: z.union([z.string(), z.number()]).optional(),
  actionId: z.string().uuid().optional(),
});

function view(r: any) {
  return {
    id: r.id,
    provider: r.provider,
    purpose: r.purpose,
    actionId: r.action_id,
    amount: Number(r.amount),
    amountText: fmt(Number(r.amount)),
    charged: r.charged_amount != null ? `${(Number(r.charged_amount) / 100).toFixed(2)} ${r.charged_currency}` : null,
    status: r.status,
    error: r.error,
    actionResult: r.action_result,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

/** Start a payment: returns the provider page to send the person to. */
export async function startPayment(pool: pg.Pool, gateways: Gateway[], citizenId: string, input: z.infer<typeof startSchema>) {
  const g = gateways.find((x) => x.id === input.provider);
  if (!g) throw badRequest('method_unavailable', 'That payment method is not available here');
  const cur = country().currency.code;
  let amount: number;
  let purpose: 'top_up' | 'action';
  let description: string;
  if (input.actionId) {
    const a = await one<any>(pool, `SELECT * FROM pending_actions WHERE id = $1 AND citizen_id = $2`, [input.actionId, citizenId]);
    if (!a) throw notFound('Nothing to pay');
    if (a.status !== 'pending' || new Date(a.expires_at) < new Date()) throw conflict('not_pending', 'This has expired. Start again.');
    if (Number(a.amount) <= 0) throw badRequest('nothing_to_pay', 'There is nothing to pay for this');
    amount = Number(a.amount);
    purpose = 'action';
    description = a.params?.__label ?? 'Kgotla payment';
    // Give the person time to finish at the provider.
    await pool.query(`UPDATE pending_actions SET expires_at = greatest(expires_at, now() + interval '30 minutes') WHERE id = $1`, [a.id]);
  } else {
    amount = toThebe(input.amount ?? '');
    const { topUpMax, billMin } = country().limits;
    if (amount < billMin) throw badRequest('minimum', `The minimum is ${fmt(billMin)}`);
    if (amount > topUpMax) throw badRequest('limit', `The top-up limit is ${fmt(topUpMax)}`);
    purpose = 'top_up';
    description = `Kgotla wallet top-up ${fmt(amount)}`;
  }
  const row = await one<any>(pool, `INSERT INTO external_payments (citizen_id, provider, purpose, action_id, amount, currency) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [citizenId, g.id, purpose, input.actionId ?? null, amount, cur]);
  const back = `${config.publicBaseUrl}/?payment=${row.id}`;
  try {
    const c = await g.create({ paymentId: row.id, amount, currency: cur, description, returnUrl: back, cancelUrl: `${back}&cancelled=1` });
    await pool.query(`UPDATE external_payments SET provider_ref = $2, charged_amount = $3, charged_currency = $4, status = 'pending' WHERE id = $1`, [row.id, c.providerRef, c.chargedAmount, c.chargedCurrency]);
    return { paymentId: row.id as string, redirectUrl: c.redirectUrl, amountText: fmt(amount), charged: `${(c.chargedAmount / 100).toFixed(2)} ${c.chargedCurrency}` };
  } catch (e: any) {
    await pool.query(`UPDATE external_payments SET status = 'failed', error = $2 WHERE id = $1`, [row.id, String(e?.message ?? e).slice(0, 300)]);
    throw e;
  }
}

/** Runs a prepared action once the provider has confirmed payment. Injected to avoid a module cycle. */
export type RunAction = (citizenId: string, actionId: string, via: string) => Promise<any>;

/**
 * Confirm with the provider and, if paid, credit the wallet (once) and run the
 * action being paid for. Safe to call repeatedly and from the reconciler.
 */
export async function completePayment(pool: pg.Pool, gateways: Gateway[], runAction: RunAction, paymentId: string, citizenId?: string) {
  const p = await one<any>(pool, `SELECT * FROM external_payments WHERE id = $1 ${citizenId ? 'AND citizen_id = $2' : ''}`, citizenId ? [paymentId, citizenId] : [paymentId]);
  if (!p) throw notFound('Payment not found');
  if (['paid', 'failed', 'cancelled', 'expired'].includes(p.status)) return view(p);
  const g = gateways.find((x) => x.id === p.provider);
  if (!g || !p.provider_ref) return view(p);
  const out = await g.complete(p.provider_ref, p.id);

  if (out.status === 'pending') return view(p);
  if (out.status !== 'paid') {
    const r = await one<any>(pool, `UPDATE external_payments SET status = $2, error = $3, completed_at = now() WHERE id = $1 AND status IN ('created','pending') RETURNING *`, [p.id, out.status, out.detail ?? null]);
    return view(r ?? p);
  }
  // The provider must have taken exactly what we asked for.
  if (out.chargedAmount != null && (out.chargedAmount !== Number(p.charged_amount) || (out.chargedCurrency && out.chargedCurrency !== p.charged_currency))) {
    const r = await one<any>(pool, `UPDATE external_payments SET status = 'failed', error = $2, completed_at = now() WHERE id = $1 RETURNING *`, [p.id, `Amount mismatch: provider reports ${out.chargedAmount} ${out.chargedCurrency}`]);
    return view(r);
  }

  const credited = await tx(pool, async (c) => {
    const row = await one<any>(c, 'SELECT * FROM external_payments WHERE id = $1 FOR UPDATE', [p.id]);
    if (row.status === 'paid') return row;
    const acct = `settlement:${p.provider}`;
    await ensureAccount(c, acct, 'asset', `Settlement · ${g.name}`);
    const e = await post(c, {
      kind: 'top_up',
      description: `Top up with ${g.name}`,
      idempotencyKey: `external:${p.id}`,
      meta: { paymentId: p.id, provider: p.provider, ref: p.provider_ref },
      lines: [
        { account: acct, amount: Number(p.amount) },
        { account: walletCode(p.citizen_id), amount: -Number(p.amount) },
      ],
    });
    await audit(c, `citizen:${p.citizen_id}`, 'payment.received', `payment:${p.id}`, { provider: p.provider, amount: Number(p.amount), charged: `${p.charged_amount} ${p.charged_currency}` });
    await notify(c, p.citizen_id, 'Payment received', `${fmt(Number(p.amount))} from ${g.name} is in your wallet.`, { sms: false });
    return one<any>(c, `UPDATE external_payments SET status = 'paid', completed_at = now(), entry_id = $2, provider_state = provider_state || $3 WHERE id = $1 RETURNING *`, [p.id, e.entryId, JSON.stringify(out.state ?? {})]);
  });

  if (credited.purpose === 'action' && credited.action_id && !credited.action_result) {
    let result: any;
    try {
      const a = await runAction(credited.citizen_id, credited.action_id, p.provider);
      result = { status: a.status, message: a.result?.message ?? null, action: a };
    } catch (e: any) {
      // The money stays in the wallet; the person can try again or use it elsewhere.
      result = { status: 'failed', message: `${e?.message ?? 'Could not complete'}. The ${fmt(Number(p.amount))} you paid is in your wallet.` };
    }
    const r = await one<any>(pool, 'UPDATE external_payments SET action_result = $2 WHERE id = $1 RETURNING *', [p.id, JSON.stringify(result)]);
    return view(r);
  }
  return view(credited);
}

export async function myPayments(db: Queryable, citizenId: string) {
  return (await many<any>(db, 'SELECT * FROM external_payments WHERE citizen_id = $1 ORDER BY created_at DESC LIMIT 20', [citizenId])).map(view);
}

/** Demo test checkout: the person approves or cancels on /pay-test.html. */
export async function decideTestPayment(pool: pg.Pool, paymentId: string, approve: boolean) {
  if (!config.demoMode) throw notFound('Unknown endpoint');
  const r = await one<any>(pool, `UPDATE external_payments SET provider_state = provider_state || $2 WHERE id = $1 AND provider = 'test' AND status = 'pending' RETURNING id, amount`, [paymentId, JSON.stringify({ testDecision: approve ? 'approve' : 'cancel' })]);
  if (!r) throw notFound('No test payment waiting with that id');
  return { ok: true, amountText: fmt(Number(r.amount)) };
}

export async function testPaymentInfo(pool: pg.Pool, paymentId: string) {
  if (!config.demoMode) throw notFound('Unknown endpoint');
  const r = await one<any>(pool, `SELECT e.amount, e.status, e.purpose, c.first_name FROM external_payments e JOIN citizens c ON c.id = e.citizen_id WHERE e.id = $1 AND e.provider = 'test'`, [paymentId]);
  if (!r) throw notFound('Payment not found');
  return { amountText: fmt(Number(r.amount)), status: r.status, purpose: r.purpose, name: r.first_name, returnUrl: `${config.publicBaseUrl}/?payment=${paymentId}` };
}

/**
 * Catch payments whose return trip was lost (closed browser, dropped network):
 * ask the provider about anything still open from the last day, and expire the rest.
 */
export async function reconcilePayments(pool: pg.Pool, gateways: Gateway[], runAction: RunAction) {
  const open = await many<any>(pool, `SELECT id FROM external_payments WHERE status = 'pending' AND created_at < now() - interval '2 minutes' AND created_at > now() - interval '1 day' ORDER BY created_at LIMIT 25`);
  for (const r of open) await completePayment(pool, gateways, runAction, r.id).catch(() => undefined);
  await pool.query(`UPDATE external_payments SET status = 'expired', completed_at = now() WHERE status IN ('created','pending') AND created_at < now() - interval '1 day'`);
  return open.length;
}
