import type pg from 'pg';
import { z } from 'zod';
import { config } from '../config.js';
import { country } from '../countries/index.js';
import { COUNTRY_PARTNERS, LOCATIONS_MANAGE, PARTNER_TYPE_INFO, PARTNER_TYPES, SCOPE_IDS, SCOPES, type PartnerType } from '../countries/partners.js';
import { many, one, tx, type Queryable } from '../db.js';
import { audit } from '../lib/audit.js';
import { createSession, verifyPin } from '../lib/auth.js';
import { hashIdentifier, hashSecret, randomToken, signPayload, verifySecret } from '../lib/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { fmt, toThebe } from '../lib/money.js';
import { notify } from '../lib/notify.js';
import { slotInstant, timeLabel } from '../lib/time.js';
import { checkWebhookUrl, enqueueEvent, subjectFor, webhookSecret, WEBHOOK_EVENTS } from '../lib/webhooks.js';
import { nationalId, normalisePhone } from './identity.js';
import { issueDocument } from './vault.js';
import { partnerListings, partnerTourismBookings } from './tourism.js';

/**
 * Partner hub: how clinics, doctors, banks, mobile-money operators, insurers,
 * utilities, schools and employers connect to Kgotla.
 *
 *   1. Apply (partner portal). Kgotla checks the licence with the regulator.
 *   2. A Kgotla admin reviews and approves, granting capabilities that fit the partner type.
 *   3. The partner creates API credentials and sets a webhook URL in the portal.
 *   4. Its systems get an OAuth access token and ask citizens for consent.
 *   5. Each citizen approves with their PIN in the app, and can withdraw at any time.
 *
 * Partners never see Kgotla's internal citizen ids: each gets a pairwise
 * "subject" id per citizen. Nothing moves money without the citizen's PIN.
 */

const CONSENT_REQUEST_HOURS = 48;
const CONSENT_GRANT_DAYS = 365;
const TOKEN_TTL_HOURS = 1;
const DECLINE_COOLDOWN_DAYS = 7;

// ---------------------------------------------------------------------------
// Regulator checks
// ---------------------------------------------------------------------------

export interface LicenceCheck {
  status: 'verified' | 'not_found' | 'unavailable';
  register: string;
  checkedAt: string;
  detail: string;
}

/** Looks up a licence or practice number in the regulator's register. Production: one adapter per regulator (API, data file or manual check). */
export interface RegulatorRegistry {
  check(type: PartnerType, licenceNo: string, legalName: string): Promise<LicenceCheck>;
}

/** Demo register: every well-formed number is found, except ones starting with X (to show a failed check). */
export class MockRegulator implements RegulatorRegistry {
  async check(type: PartnerType, licenceNo: string, legalName: string): Promise<LicenceCheck> {
    const reg = COUNTRY_PARTNERS[country().code].regulators[type];
    const ok = /^[A-Z0-9][A-Z0-9/ -]{2,30}$/i.test(licenceNo) && !/^x/i.test(licenceNo);
    return {
      status: ok ? 'verified' : 'not_found',
      register: `${reg.name} (demo register)`,
      checkedAt: new Date().toISOString(),
      detail: ok ? `${licenceNo} is listed for ${legalName} and is in good standing.` : `${licenceNo} was not found in the register.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Catalogue (public): what each partner type can do and who licenses it here
// ---------------------------------------------------------------------------

export function catalogue() {
  const cp = COUNTRY_PARTNERS[country().code];
  return {
    country: country().code,
    companyRegistry: cp.companyRegistry,
    types: PARTNER_TYPES.map((t) => ({
      type: t,
      label: PARTNER_TYPE_INFO[t].label,
      regulator: cp.regulators[t],
      capabilities: PARTNER_TYPE_INFO[t].capabilities,
      documentTypes: PARTNER_TYPE_INFO[t].documentTypes,
    })),
    scopes: SCOPE_IDS.map((s) => ({ scope: s, description: SCOPES[s].name })),
    events: WEBHOOK_EVENTS,
  };
}

// ---------------------------------------------------------------------------
// Applying and the partner portal
// ---------------------------------------------------------------------------

export const applySchema = z.object({
  type: z.enum(PARTNER_TYPES),
  legalName: z.string().trim().min(3).max(120),
  tradingName: z.string().trim().min(2).max(80).optional(),
  registrationNo: z.string().trim().min(3).max(40),
  licenceNo: z.string().trim().min(3).max(40),
  contactName: z.string().trim().min(2).max(80),
  contactEmail: z.string().trim().toLowerCase().email().max(120),
  contactPhone: z.string().trim().min(6).max(20),
  password: z.string().min(10, 'Use at least 10 characters for the portal password').max(200),
  webhookUrl: z.string().trim().max(300).optional(),
});

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'partner';

export async function applyPartner(pool: pg.Pool, regulator: RegulatorRegistry, input: z.infer<typeof applySchema>) {
  const tradingName = input.tradingName || input.legalName;
  const webhook = input.webhookUrl ? checkWebhookUrl(input.webhookUrl) : null;
  if (await one(pool, 'SELECT 1 FROM partners WHERE contact_email = $1', [input.contactEmail])) {
    throw conflict('already_applied', 'An application already uses that email. Sign in to the partner portal to see its status.');
  }
  const check = await regulator.check(input.type, input.licenceNo, input.legalName);
  const reg = COUNTRY_PARTNERS[country().code].regulators[input.type];
  return tx(pool, async (c) => {
    let code = slug(tradingName);
    if (await one(c, 'SELECT 1 FROM partners WHERE code = $1', [code])) code = `${code.slice(0, 26)}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    const row = await one<any>(
      c,
      `INSERT INTO partners (code, type, legal_name, trading_name, registration_no, licence_no, regulator, licence_check,
                             contact_name, contact_email, contact_phone, portal_password_hash, webhook_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, code, status`,
      [code, input.type, input.legalName, tradingName, input.registrationNo, input.licenceNo, `${reg.code} · ${reg.name}`, JSON.stringify(check),
        input.contactName, input.contactEmail, normalisePhone(input.contactPhone), await hashSecret(input.password), webhook],
    );
    await audit(c, `partner:${row.id}`, 'partner.applied', `partner:${row.id}`, { type: input.type, licenceCheck: check.status });
    return { partnerId: row.id as string, code: row.code as string, status: row.status as string, licenceCheck: check };
  });
}

export async function portalLogin(pool: pg.Pool, email: string, password: string) {
  const p = await one<any>(pool, 'SELECT id, portal_password_hash, status FROM partners WHERE contact_email = $1', [email.trim().toLowerCase()]);
  if (!p || !(await verifySecret(password, p.portal_password_hash))) throw unauthorized('Email or password is not correct');
  if (p.status === 'rejected') throw forbidden('This application was not approved. Contact Kgotla partner support.');
  const s = await createSession(pool, 'partner_portal', p.id, 'partner portal', 8);
  return { token: s.token, expiresAt: s.expiresAt };
}

async function partnerRow(db: Queryable, id: string) {
  const p = await one<any>(db, 'SELECT * FROM partners WHERE id = $1', [id]);
  if (!p) throw notFound('Partner not found');
  return p;
}

const publicPartner = (p: any) => ({
  id: p.id,
  code: p.code,
  type: p.type,
  typeLabel: PARTNER_TYPE_INFO[p.type as PartnerType].label,
  legalName: p.legal_name,
  tradingName: p.trading_name,
  registrationNo: p.registration_no,
  licenceNo: p.licence_no,
  regulator: p.regulator,
  licenceCheck: p.licence_check,
  contactName: p.contact_name,
  contactEmail: p.contact_email,
  contactPhone: p.contact_phone,
  status: p.status,
  capabilities: p.capabilities,
  webhookUrl: p.webhook_url,
  reviewNote: p.review_note,
  reviewedAt: p.reviewed_at,
  createdAt: p.created_at,
});

/** Everything the portal dashboard shows. */
export async function portalView(db: Queryable, partnerId: string) {
  const p = await partnerRow(db, partnerId);
  const [creds, deliveries, consents, payments, locations, inbox] = await Promise.all([
    many<any>(db, 'SELECT id, client_id, label, created_at, last_used_at, revoked_at FROM partner_credentials WHERE partner_id = $1 ORDER BY created_at DESC', [partnerId]),
    many<any>(db, 'SELECT id, event, status, attempts, last_status, last_error, created_at, delivered_at FROM webhook_deliveries WHERE partner_id = $1 ORDER BY id DESC LIMIT 15', [partnerId]),
    one<any>(
      db,
      `SELECT count(*) FILTER (WHERE status = 'granted' AND expires_at > now())::int AS granted,
              count(*) FILTER (WHERE status = 'requested' AND request_expires_at > now())::int AS waiting,
              count(*) FILTER (WHERE status IN ('declined','revoked'))::int AS declined_or_revoked
         FROM consents WHERE partner_id = $1`,
      [partnerId],
    ),
    one<any>(
      db,
      `SELECT count(*) FILTER (WHERE status = 'paid')::int AS paid, COALESCE(sum(amount) FILTER (WHERE status = 'paid'),0)::bigint AS paid_total,
              count(*) FILTER (WHERE status = 'pending' AND expires_at > now())::int AS pending
         FROM payment_requests WHERE partner_id = $1`,
      [partnerId],
    ),
    many<any>(db, 'SELECT id, name, capacity, slot_times FROM locations WHERE partner_id = $1 ORDER BY name', [partnerId]),
    config.demoMode ? many<any>(db, 'SELECT event, signature_ok, received_at FROM demo_webhook_inbox WHERE partner_code = $1 ORDER BY id DESC LIMIT 5', [p.code]) : Promise.resolve([]),
  ]);
  const tourism = (p.capabilities as string[]).includes('listings.manage')
    ? { listings: await partnerListings(db, partnerId), bookings: await partnerTourismBookings(db, partnerId, undefined, 60) }
    : null;
  return {
    partner: publicPartner(p),
    tourism,
    credentials: creds.map((c) => ({ id: c.id, clientId: c.client_id, label: c.label, createdAt: c.created_at, lastUsedAt: c.last_used_at, revoked: !!c.revoked_at })),
    webhook: { url: p.webhook_url, deliveries, demoInbox: inbox },
    consents,
    payments: { ...payments, paidTotalText: fmt(payments.paid_total) },
    locations,
    apiBase: `${config.publicBaseUrl}/v1`,
  };
}

function requireApproved(p: any) {
  if (p.status !== 'approved') {
    throw new AppError(403, 'not_approved', p.status === 'suspended' ? 'This partner is suspended. Contact Kgotla partner support.' : 'Your application is still being reviewed. You can create API keys once it is approved.');
  }
}

export async function createCredential(db: Queryable, partnerId: string, label = 'API key') {
  const p = await partnerRow(db, partnerId);
  requireApproved(p);
  const active = await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM partner_credentials WHERE partner_id = $1 AND revoked_at IS NULL', [partnerId]);
  if ((active?.n ?? 0) >= 5) throw conflict('too_many_keys', 'You can have 5 active API keys. Revoke one first.');
  const clientId = `${p.code}_${randomToken(6).replace(/[^A-Za-z0-9]/g, 'x')}`;
  const secret = 'ks_' + randomToken(32);
  const r = await one<any>(db, 'INSERT INTO partner_credentials (partner_id, client_id, secret_hash, label) VALUES ($1,$2,$3,$4) RETURNING id', [partnerId, clientId, await hashSecret(secret), label.slice(0, 60)]);
  await audit(db, `partner:${partnerId}`, 'partner.credential_created', `credential:${r.id}`, { clientId });
  return { id: r.id as string, clientId, clientSecret: secret };
}

export async function revokeCredential(db: Queryable, partnerId: string, credentialId: string) {
  const r = await db.query('UPDATE partner_credentials SET revoked_at = now() WHERE id = $1 AND partner_id = $2 AND revoked_at IS NULL', [credentialId, partnerId]);
  if (!r.rowCount) throw notFound('API key not found');
  await audit(db, `partner:${partnerId}`, 'partner.credential_revoked', `credential:${credentialId}`);
}

export async function setWebhook(db: Queryable, partnerId: string, url: string | null) {
  const clean = url ? checkWebhookUrl(url) : null;
  await db.query('UPDATE partners SET webhook_url = $2 WHERE id = $1', [partnerId, clean]);
  await audit(db, `partner:${partnerId}`, 'partner.webhook_set', `partner:${partnerId}`, { url: clean });
  return { url: clean };
}

export async function revealWebhookSecret(db: Queryable, partnerId: string, rotate = false) {
  const p = rotate
    ? await one<any>(db, 'UPDATE partners SET webhook_secret_version = webhook_secret_version + 1 WHERE id = $1 RETURNING id, webhook_secret_version', [partnerId])
    : await one<any>(db, 'SELECT id, webhook_secret_version FROM partners WHERE id = $1', [partnerId]);
  if (rotate) await audit(db, `partner:${partnerId}`, 'partner.webhook_secret_rotated', `partner:${partnerId}`);
  return { secret: webhookSecret(p.id, p.webhook_secret_version) };
}

export async function sendTestEvent(db: Queryable, partnerId: string) {
  const p = await partnerRow(db, partnerId);
  requireApproved(p);
  if (!p.webhook_url) throw badRequest('no_webhook', 'Set a webhook URL first');
  await enqueueEvent(db, partnerId, 'ping', { message: 'Hello from Kgotla. Your webhook works.' });
  return { queued: true };
}

/** OAuth 2.0 client-credentials grant. */
export async function issueToken(pool: pg.Pool, clientId: string, clientSecret: string) {
  const c = await one<any>(
    pool,
    `SELECT c.id, c.secret_hash, c.partner_id, p.status, p.capabilities FROM partner_credentials c JOIN partners p ON p.id = c.partner_id
      WHERE c.client_id = $1 AND c.revoked_at IS NULL`,
    [clientId],
  );
  if (!c || !(await verifySecret(clientSecret, c.secret_hash))) return null;
  if (c.status !== 'approved') return null;
  await pool.query('UPDATE partner_credentials SET last_used_at = now() WHERE id = $1', [c.id]);
  const s = await createSession(pool, 'partner_api', c.partner_id, `api ${clientId}`, TOKEN_TTL_HOURS);
  return { access_token: s.token, token_type: 'Bearer', expires_in: TOKEN_TTL_HOURS * 3600, scope: (c.capabilities as string[]).join(' ') };
}

// ---------------------------------------------------------------------------
// Review by Kgotla admins
// ---------------------------------------------------------------------------

export async function listPartners(db: Queryable, status?: string) {
  const rows = await many<any>(db, `SELECT * FROM partners ${status ? 'WHERE status = $1' : ''} ORDER BY created_at DESC LIMIT 200`, status ? [status] : []);
  return rows.map(publicPartner);
}

export async function approvePartner(db: Queryable, partnerId: string, officerId: string, opts: { capabilities?: string[]; note?: string }) {
  const p = await one<any>(db, 'SELECT * FROM partners WHERE id = $1 FOR UPDATE', [partnerId]);
  if (!p) throw notFound('Partner not found');
  if (p.status === 'approved') throw conflict('already_approved', 'This partner is already approved');
  if (p.status !== 'applied') throw conflict('invalid_status', p.status === 'suspended' ? 'Use reinstate for a suspended partner' : `Cannot approve a ${p.status} partner`);
  const allowed = PARTNER_TYPE_INFO[p.type as PartnerType].capabilities;
  const caps = opts.capabilities ?? allowed;
  const bad = caps.filter((c) => !allowed.includes(c));
  if (bad.length) throw badRequest('invalid_capability', `A ${PARTNER_TYPE_INFO[p.type as PartnerType].label.toLowerCase()} cannot have: ${bad.join(', ')}`);
  await db.query(`UPDATE partners SET status = 'approved', capabilities = $2, review_note = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1`, [partnerId, caps, opts.note ?? null, officerId]);
  // Documents a partner issues name it as the issuer.
  await db.query('INSERT INTO issuers (id, name, api_key_hash) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name', [p.code, p.trading_name, 'partner-api']);
  await audit(db, `officer:${officerId}`, 'partner.approved', `partner:${partnerId}`, { capabilities: caps, licenceCheck: p.licence_check?.status ?? null });
  await enqueueEvent(db, partnerId, 'partner.approved', { capabilities: caps });
}

export async function setPartnerStatus(db: Queryable, partnerId: string, officerId: string, status: 'rejected' | 'suspended' | 'approved', note: string) {
  const p = await one<any>(db, 'SELECT status FROM partners WHERE id = $1 FOR UPDATE', [partnerId]);
  if (!p) throw notFound('Partner not found');
  const ok = (status === 'rejected' && p.status === 'applied') || (status === 'suspended' && p.status === 'approved') || (status === 'approved' && p.status === 'suspended');
  if (!ok) throw conflict('invalid_status', `Cannot change a partner from ${p.status} to ${status}`);
  if (status === 'suspended') await enqueueEvent(db, partnerId, 'partner.suspended', { reason: note });
  await db.query('UPDATE partners SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1', [partnerId, status, note, officerId]);
  if (status !== 'approved') await db.query(`UPDATE sessions SET revoked_at = now() WHERE subject_type = 'partner_api' AND subject_id = $1 AND revoked_at IS NULL`, [partnerId]);
  await audit(db, `officer:${officerId}`, `partner.${status === 'approved' ? 'reinstated' : status}`, `partner:${partnerId}`, { note });
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

export const consentRequestSchema = z
  .object({
    nationalId: z.string().optional(),
    phone: z.string().optional(),
    scopes: z.array(z.string()).min(1).max(SCOPE_IDS.length),
    purpose: z.string().trim().min(5).max(160),
  })
  .refine((v) => v.nationalId || v.phone, { message: 'Send nationalId or phone' });

export async function requestConsent(db: Queryable, partnerId: string, input: z.infer<typeof consentRequestSchema>) {
  const p = await partnerRow(db, partnerId);
  requireApproved(p);
  const scopes = [...new Set(input.scopes)].sort();
  const unknown = scopes.filter((s) => !SCOPE_IDS.includes(s as any));
  if (unknown.length) throw badRequest('invalid_scope', `Unknown scope: ${unknown.join(', ')}. Use: ${SCOPE_IDS.join(', ')}`);
  const notAllowed = scopes.filter((s) => !(p.capabilities as string[]).includes(s));
  if (notAllowed.length) throw forbidden(`Your approval does not include: ${notAllowed.join(', ')}`);
  const c = input.nationalId
    ? await one<any>(db, 'SELECT id, first_name FROM citizens WHERE omang_hash = $1', [hashIdentifier(nationalId(input.nationalId))])
    : await one<any>(db, 'SELECT id, first_name FROM citizens WHERE phone = $1', [normalisePhone(input.phone!)]);
  if (!c) throw notFound('This person does not have a Kgotla account yet. Ask them to register in the Kgotla app or by USSD.');
  const subject = subjectFor(partnerId, c.id);

  // Already granted with these scopes: nothing to ask.
  const granted = await one<any>(db, `SELECT * FROM consents WHERE partner_id = $1 AND citizen_id = $2 AND status = 'granted' AND expires_at > now() AND scopes @> $3 ORDER BY created_at DESC LIMIT 1`, [partnerId, c.id, scopes]);
  if (granted) return consentForPartner(granted);
  const waiting = await one<any>(db, `SELECT * FROM consents WHERE partner_id = $1 AND citizen_id = $2 AND status = 'requested' AND request_expires_at > now() AND scopes = $3 LIMIT 1`, [partnerId, c.id, scopes]);
  if (waiting) return consentForPartner(waiting);
  // No nagging: after a "no", the same organisation must wait before asking again.
  const declined = await one<any>(db, `SELECT decided_at FROM consents WHERE partner_id = $1 AND citizen_id = $2 AND status IN ('declined','revoked') AND COALESCE(revoked_at, decided_at) > now() - make_interval(days => $3) LIMIT 1`, [partnerId, c.id, DECLINE_COOLDOWN_DAYS]);
  if (declined) throw new AppError(429, 'recently_declined', `This person said no or withdrew access in the last ${DECLINE_COOLDOWN_DAYS} days. Ask them in person before sending a new request.`);

  const row = await one<any>(
    db,
    `INSERT INTO consents (partner_id, citizen_id, subject, scopes, purpose, request_expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => $6)) RETURNING *`,
    [partnerId, c.id, subject, scopes, input.purpose, CONSENT_REQUEST_HOURS],
  );
  await notify(db, c.id, `${p.trading_name} asks for access`, `${input.purpose}. Open Kgotla to approve or decline.`, { sms: true });
  await audit(db, `partner:${partnerId}`, 'consent.requested', `consent:${row.id}`, { citizenId: c.id, scopes });
  return consentForPartner(row);
}

function consentForPartner(r: any) {
  const expired = r.status === 'requested' && new Date(r.request_expires_at) < new Date();
  const status = expired ? 'expired' : r.status === 'granted' && r.expires_at && new Date(r.expires_at) < new Date() ? 'expired' : r.status;
  return {
    consentId: r.id,
    status,
    scopes: r.scopes,
    purpose: r.purpose,
    // The pairwise subject id is only shared once the citizen agrees.
    subject: status === 'granted' || status === 'revoked' ? r.subject : null,
    requestExpiresAt: r.request_expires_at,
    expiresAt: r.expires_at,
    decidedAt: r.decided_at,
  };
}

export async function getConsentForPartner(db: Queryable, partnerId: string, consentId: string) {
  const r = await one<any>(db, 'SELECT * FROM consents WHERE id = $1 AND partner_id = $2', [consentId, partnerId]);
  if (!r) throw notFound('Consent request not found');
  return consentForPartner(r);
}

const scopeList = (scopes: string[]) => scopes.map((s) => ({ scope: s, description: SCOPES[s as keyof typeof SCOPES]?.name ?? s }));

/** What the citizen sees: requests waiting for them and organisations they have connected. */
export async function myConsents(db: Queryable, citizenId: string) {
  const rows = await many<any>(
    db,
    `SELECT c.*, p.trading_name, p.type, p.regulator, p.licence_no, p.status AS partner_status
       FROM consents c JOIN partners p ON p.id = c.partner_id
      WHERE c.citizen_id = $1 AND ((c.status = 'requested' AND c.request_expires_at > now()) OR (c.status = 'granted' AND c.expires_at > now()))
      ORDER BY c.created_at DESC`,
    [citizenId],
  );
  const view = (r: any) => ({
    id: r.id,
    partner: { name: r.trading_name, type: r.type, typeLabel: PARTNER_TYPE_INFO[r.type as PartnerType].label, regulator: r.regulator, licenceNo: r.licence_no, active: r.partner_status === 'approved' },
    purpose: r.purpose,
    scopes: scopeList(r.scopes),
    status: r.status,
    requestedAt: r.created_at,
    grantedAt: r.decided_at,
    expiresAt: r.status === 'granted' ? r.expires_at : r.request_expires_at,
  });
  return { requests: rows.filter((r) => r.status === 'requested').map(view), connected: rows.filter((r) => r.status === 'granted').map(view) };
}

export async function decideConsent(pool: pg.Pool, citizenId: string, consentId: string, decision: 'grant' | 'decline', pin?: string) {
  if (decision === 'grant') {
    if (!pin) throw new AppError(401, 'pin_required', 'Enter your PIN to approve');
    await verifyPin(pool, citizenId, pin);
  }
  return tx(pool, async (c) => {
    const r = await one<any>(c, 'SELECT * FROM consents WHERE id = $1 AND citizen_id = $2 FOR UPDATE', [consentId, citizenId]);
    if (!r) throw notFound('Request not found');
    if (r.status !== 'requested') throw conflict('already_decided', 'You already answered this request');
    if (new Date(r.request_expires_at) < new Date()) {
      await c.query(`UPDATE consents SET status = 'expired' WHERE id = $1`, [consentId]);
      throw new AppError(410, 'expired', 'This request has expired. Ask the organisation to send it again.');
    }
    const status = decision === 'grant' ? 'granted' : 'declined';
    const u = await one<any>(
      c,
      `UPDATE consents SET status = $2, decided_at = now(), expires_at = CASE WHEN $2 = 'granted' THEN now() + make_interval(days => $3) END WHERE id = $1 RETURNING *`,
      [consentId, status, CONSENT_GRANT_DAYS],
    );
    await audit(c, `citizen:${citizenId}`, `consent.${status}`, `consent:${consentId}`, { partnerId: r.partner_id, scopes: r.scopes, confirmedWith: decision === 'grant' ? 'pin' : 'tap' });
    await enqueueEvent(c, r.partner_id, decision === 'grant' ? 'consent.granted' : 'consent.declined', {
      consentId,
      ...(decision === 'grant' ? { subject: r.subject, scopes: r.scopes, expiresAt: u.expires_at } : {}),
    });
    return { id: consentId, status };
  });
}

export async function revokeConsent(pool: pg.Pool, citizenId: string, consentId: string) {
  return tx(pool, async (c) => {
    const r = await one<any>(c, `UPDATE consents SET status = 'revoked', revoked_at = now() WHERE id = $1 AND citizen_id = $2 AND status = 'granted' RETURNING *`, [consentId, citizenId]);
    if (!r) throw notFound('Connection not found');
    await audit(c, `citizen:${citizenId}`, 'consent.revoked', `consent:${consentId}`, { partnerId: r.partner_id });
    await enqueueEvent(c, r.partner_id, 'consent.revoked', { consentId, subject: r.subject, scopes: r.scopes });
    return { id: consentId, status: 'revoked' };
  });
}

/** The citizen behind a subject id, if they have granted this scope to this partner and not withdrawn it. */
export async function requireGrant(db: Queryable, partnerId: string, subject: string, scope: string): Promise<string> {
  const r = await one<any>(
    db,
    `SELECT citizen_id FROM consents WHERE partner_id = $1 AND subject = $2 AND status = 'granted' AND expires_at > now() AND $3 = ANY(scopes) LIMIT 1`,
    [partnerId, subject, scope],
  );
  if (!r) throw new AppError(403, 'consent_required', `This person has not given you "${scope}" access, or has withdrawn it. Send a consent request.`);
  return r.citizen_id;
}

// ---------------------------------------------------------------------------
// What partners can do with consent
// ---------------------------------------------------------------------------

/** identity.basic: name and ID last 4. identity.kyc: verified identity, signed so it can be kept as KYC evidence. */
export async function partnerIdentity(db: Queryable, partnerId: string, subject: string) {
  let kyc = true;
  let citizenId: string;
  try {
    citizenId = await requireGrant(db, partnerId, subject, 'identity.kyc');
  } catch {
    kyc = false;
    citizenId = await requireGrant(db, partnerId, subject, 'identity.basic');
  }
  const c = await one<any>(db, 'SELECT first_name, last_name, omang_last4, dob, district, phone, loa, created_at FROM citizens WHERE id = $1', [citizenId]);
  const p = await one<any>(db, 'SELECT code FROM partners WHERE id = $1', [partnerId]);
  const claims: Record<string, unknown> = {
    name: `${c.first_name} ${c.last_name}`,
    id_last4: c.omang_last4,
    id_type: country().nationalId.name,
    country: country().code,
  };
  if (kyc) {
    Object.assign(claims, {
      given_name: c.first_name,
      family_name: c.last_name,
      birthdate: typeof c.dob === 'string' ? c.dob : new Date(c.dob).toISOString().slice(0, 10),
      district: c.district,
      phone_number: c.phone,
      assurance_level: c.loa,
      id_verified: c.loa >= 3,
      id_verified_by: c.loa >= 3 ? `${country().agencies.civil.name} register, face match at enrolment` : 'Not verified: phone number proven by SMS, identity details declared by the person',
      enrolled_at: c.created_at,
    });
  }
  await audit(db, `partner:${partnerId}`, kyc ? 'identity.kyc_read' : 'identity.basic_read', `subject:${subject}`, { citizenId });
  const iat = Math.floor(Date.now() / 1000);
  return {
    subject,
    level: kyc ? 'kyc' : 'basic',
    claims,
    // Signed by this Kgotla cell so it can be stored as evidence for AML/KYC audits.
    attestation: signPayload({ iss: `kgotla-${country().code.toLowerCase()}`, aud: p.code, sub: subject, iat, claims }),
  };
}

export async function partnerDocuments(db: Queryable, partnerId: string, subject: string) {
  const citizenId = await requireGrant(db, partnerId, subject, 'documents.read');
  await audit(db, `partner:${partnerId}`, 'documents.listed', `subject:${subject}`, { citizenId });
  return many<any>(
    db,
    `SELECT d.type, d.title, d.ref, d.issued_at, d.valid_to, i.name AS issuer FROM documents d JOIN issuers i ON i.id = d.issuer_id
      WHERE d.citizen_id = $1 AND d.status = 'valid' ORDER BY d.issued_at DESC`,
    [citizenId],
  );
}

export const partnerDocSchema = z.object({
  type: z.string().min(2).max(40),
  title: z.string().trim().min(2).max(120),
  ref: z.string().trim().max(60).optional(),
  validTo: z.string().optional(),
  data: z.record(z.any()).optional(),
});

export async function partnerIssueDocument(db: Queryable, partnerId: string, subject: string, d: z.infer<typeof partnerDocSchema>) {
  const p = await partnerRow(db, partnerId);
  const citizenId = await requireGrant(db, partnerId, subject, 'documents.issue');
  const allowed = PARTNER_TYPE_INFO[p.type as PartnerType].documentTypes;
  if (!allowed.includes(d.type)) throw badRequest('invalid_document_type', `A ${PARTNER_TYPE_INFO[p.type as PartnerType].label.toLowerCase()} can issue: ${allowed.join(', ')}`);
  const validTo = d.validTo ? new Date(d.validTo) : null;
  if (validTo && isNaN(validTo.getTime())) throw badRequest('invalid_date', 'validTo must be a date, for example 2027-01-31');
  const id = await issueDocument(db, citizenId, { type: d.type, title: d.title, issuerId: p.code, ref: d.ref, validTo, data: d.data }, `partner:${partnerId}`);
  return { documentId: id };
}

export const notifySchema = z.object({ title: z.string().trim().min(2).max(60), body: z.string().trim().min(2).max(300), sms: z.boolean().default(false) });

export async function partnerNotify(db: Queryable, partnerId: string, subject: string, n: z.infer<typeof notifySchema>) {
  const p = await partnerRow(db, partnerId);
  const citizenId = await requireGrant(db, partnerId, subject, 'notifications.send');
  await notify(db, citizenId, `${p.trading_name}: ${n.title}`, n.body, { sms: n.sms });
  await audit(db, `partner:${partnerId}`, 'notification.sent', `subject:${subject}`, { sms: n.sms });
  return { sent: true };
}

// ---------------------------------------------------------------------------
// Payment requests (bills from partners, paid by the citizen with their PIN)
// ---------------------------------------------------------------------------

export const paymentRequestSchema = z.object({
  amount: z.union([z.string(), z.number()]),
  reference: z.string().trim().min(2).max(40),
  description: z.string().trim().min(2).max(120),
  expiresInHours: z.number().int().min(1).max(720).default(72),
});

const paymentView = (r: any) => ({
  id: r.id,
  status: r.status === 'pending' && new Date(r.expires_at) < new Date() ? 'expired' : r.status,
  amount: Number(r.amount),
  amountText: fmt(Number(r.amount)),
  currency: country().currency.code,
  reference: r.reference,
  description: r.description,
  expiresAt: r.expires_at,
  paidAt: r.paid_at,
  createdAt: r.created_at,
});

export async function createPaymentRequest(db: Queryable, partnerId: string, subject: string, input: z.infer<typeof paymentRequestSchema>) {
  const p = await partnerRow(db, partnerId);
  const citizenId = await requireGrant(db, partnerId, subject, 'payments.request');
  const amount = toThebe(input.amount);
  if (amount <= 0) throw badRequest('invalid_amount', 'The amount must be more than zero');
  if (amount > country().limits.topUpMax) throw badRequest('limit', `One payment request can be at most ${fmt(country().limits.topUpMax)}`);
  const existing = await one<any>(db, 'SELECT * FROM payment_requests WHERE partner_id = $1 AND reference = $2', [partnerId, input.reference]);
  if (existing) {
    // Idempotent on reference: a retried request returns the original.
    if (Number(existing.amount) !== amount || existing.citizen_id !== citizenId) throw conflict('duplicate_reference', 'You already used that reference for a different payment request');
    return paymentView(existing);
  }
  const r = await one<any>(
    db,
    `INSERT INTO payment_requests (partner_id, citizen_id, amount, reference, description, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => $6)) RETURNING *`,
    [partnerId, citizenId, amount, input.reference, input.description, input.expiresInHours],
  );
  await notify(db, citizenId, `Bill from ${p.trading_name}`, `${fmt(amount)} · ${input.description}. Open Kgotla to pay.`, { sms: true });
  await audit(db, `partner:${partnerId}`, 'payment_request.created', `payment_request:${r.id}`, { citizenId, amount, reference: input.reference });
  return paymentView(r);
}

export async function getPaymentRequest(db: Queryable, partnerId: string, id: string) {
  const r = await one<any>(db, 'SELECT * FROM payment_requests WHERE id = $1 AND partner_id = $2', [id, partnerId]);
  if (!r) throw notFound('Payment request not found');
  return paymentView(r);
}

export async function cancelPaymentRequest(db: Queryable, partnerId: string, id: string) {
  const r = await one<any>(db, `UPDATE payment_requests SET status = 'cancelled' WHERE id = $1 AND partner_id = $2 AND status = 'pending' RETURNING *`, [id, partnerId]);
  if (!r) throw notFound('No pending payment request with that id');
  await audit(db, `partner:${partnerId}`, 'payment_request.cancelled', `payment_request:${id}`);
  return paymentView(r);
}

export async function myPaymentRequests(db: Queryable, citizenId: string) {
  const rows = await many<any>(
    db,
    `SELECT r.*, p.trading_name FROM payment_requests r JOIN partners p ON p.id = r.partner_id
      WHERE r.citizen_id = $1 AND r.status = 'pending' AND r.expires_at > now() ORDER BY r.created_at DESC`,
    [citizenId],
  );
  return rows.map((r) => ({ ...paymentView(r), partner: r.trading_name }));
}

export async function declinePaymentRequest(pool: pg.Pool, citizenId: string, id: string) {
  return tx(pool, async (c) => {
    const r = await one<any>(c, `UPDATE payment_requests SET status = 'declined' WHERE id = $1 AND citizen_id = $2 AND status = 'pending' RETURNING *`, [id, citizenId]);
    if (!r) throw notFound('Bill not found');
    await audit(c, `citizen:${citizenId}`, 'payment_request.declined', `payment_request:${id}`);
    await enqueueEvent(c, r.partner_id, 'payment_request.declined', { paymentRequestId: id, reference: r.reference, subject: subjectFor(r.partner_id, citizenId) });
    return { id, status: 'declined' };
  });
}

// ---------------------------------------------------------------------------
// Clinics and practices: their own bookable locations
// ---------------------------------------------------------------------------

export const locationSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9-]{2,24}$/, 'Use 2 to 24 lowercase letters, digits or dashes').default('main'),
  name: z.string().trim().min(3).max(80),
  capacity: z.number().int().min(1).max(50).default(2),
  slotTimes: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Times look like 08:30')).min(1).max(40),
});

export async function upsertLocation(db: Queryable, partnerId: string, l: z.infer<typeof locationSchema>) {
  const p = await partnerRow(db, partnerId);
  requireApproved(p);
  if (!(p.capabilities as string[]).includes(LOCATIONS_MANAGE)) throw forbidden('Your approval does not include bookable locations');
  const id = `${p.code}-${l.key}`;
  const slots = [...new Set(l.slotTimes)].sort();
  await db.query(
    `INSERT INTO locations (id, kind, name, agency, capacity, slot_times, partner_id) VALUES ($1,'clinic',$2,$3,$4,$5,$6)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, capacity = EXCLUDED.capacity, slot_times = EXCLUDED.slot_times WHERE locations.partner_id = $6`,
    [id, l.name, p.code, l.capacity, slots, partnerId],
  );
  await audit(db, `partner:${partnerId}`, 'location.saved', `location:${id}`, { slots: slots.length });
  return { id, name: l.name, capacity: l.capacity, slotTimes: slots };
}

export async function partnerLocations(db: Queryable, partnerId: string) {
  return many<any>(db, 'SELECT id, name, capacity, slot_times AS "slotTimes" FROM locations WHERE partner_id = $1 ORDER BY name', [partnerId]);
}

/** Bookings at the partner's own locations. Booking a private clinic shares the patient's name with it. */
export async function partnerAppointments(db: Queryable, partnerId: string, from?: string, days = 14) {
  const start = from ? slotInstant(from, '00:00') : new Date(Date.now() - 12 * 3600_000);
  const rows = await many<any>(
    db,
    `SELECT a.id, a.citizen_id, a.starts_at, a.purpose, a.status, a.location_id, c.first_name, c.last_name
       FROM appointments a JOIN locations l ON l.id = a.location_id JOIN citizens c ON c.id = a.citizen_id
      WHERE l.partner_id = $1 AND a.starts_at >= $2 AND a.starts_at < $2::timestamptz + make_interval(days => $3)
      ORDER BY a.starts_at`,
    [partnerId, start, days],
  );
  return rows.map((r) => ({
    id: r.id,
    locationId: r.location_id,
    startsAt: r.starts_at,
    time: timeLabel(r.starts_at),
    purpose: r.purpose,
    status: r.status,
    patient: { name: `${r.first_name} ${r.last_name}`, subject: subjectFor(partnerId, r.citizen_id) },
  }));
}

export async function markAttended(db: Queryable, partnerId: string, appointmentId: string) {
  const r = await one<any>(
    db,
    `UPDATE appointments a SET status = 'attended' FROM locations l
      WHERE a.id = $1 AND l.id = a.location_id AND l.partner_id = $2 AND a.status = 'booked' RETURNING a.id`,
    [appointmentId, partnerId],
  );
  if (!r) throw notFound('No booked appointment with that id at your locations');
  await audit(db, `partner:${partnerId}`, 'appointment.attended', `appointment:${appointmentId}`);
  return { id: appointmentId, status: 'attended' };
}

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------

/** Demo partners: an approved clinic and bank (with a sample consent, bill and request) and a doctor waiting for review. */
export async function seedDemoPartners(db: Queryable, password: string, log: (m: string) => void, firstCitizenId?: string) {
  const cp = COUNTRY_PARTNERS[country().code];
  const local = !process.env.DEMO_OFFICER_PASSWORD; // fixed, published API keys only on local demo cells
  for (const d of cp.demo) {
    if (await one(db, 'SELECT 1 FROM partners WHERE code = $1', [d.code])) continue;
    const reg = cp.regulators[d.type];
    const check: LicenceCheck = { status: 'verified', register: `${reg.name} (demo register)`, checkedAt: new Date().toISOString(), detail: `${d.licenceNo} is listed for ${d.legalName} and is in good standing.` };
    const approved = d.status === 'approved';
    const p = await one<any>(
      db,
      `INSERT INTO partners (code, type, legal_name, trading_name, registration_no, licence_no, regulator, licence_check, contact_name, contact_email, contact_phone,
                             portal_password_hash, status, capabilities, webhook_url, reviewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [d.code, d.type, d.legalName, d.tradingName, d.registrationNo, d.licenceNo, `${reg.code} · ${reg.name}`, JSON.stringify(check), d.contactName, d.email, d.phone,
        await hashSecret(password), d.status, approved ? PARTNER_TYPE_INFO[d.type].capabilities : [],
        approved ? `${config.publicBaseUrl}/v1/demo/webhook-inbox/${d.code}` : null, approved ? new Date() : null],
    );
    if (approved) {
      await db.query('INSERT INTO issuers (id, name, api_key_hash) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [d.code, d.tradingName, 'partner-api']);
      if (local) {
        await db.query('INSERT INTO partner_credentials (partner_id, client_id, secret_hash, label) VALUES ($1,$2,$3,$4)', [p.id, `demo-${d.type}`, await hashSecret(`demo-${d.type}-secret`), 'Demo key']);
      }
      if (d.type === 'clinic') {
        await db.query(
          `INSERT INTO locations (id, kind, name, agency, capacity, slot_times, partner_id) VALUES ($1,'clinic',$2,$3,3,$4,$5) ON CONFLICT (id) DO NOTHING`,
          [`${d.code}-main`, `${d.tradingName} (private)`, d.code, ['08:30', '09:30', '10:30', '11:30', '14:00', '15:00'], p.id],
        );
      }
      if (firstCitizenId && d.type === 'clinic') {
        const subject = subjectFor(p.id, firstCitizenId);
        await db.query(
          `INSERT INTO consents (partner_id, citizen_id, subject, scopes, purpose, status, request_expires_at, expires_at, decided_at)
           VALUES ($1,$2,$3,$4,$5,'granted', now(), now() + interval '365 days', now())`,
          [p.id, firstCitizenId, subject, ['documents.issue', 'identity.basic', 'notifications.send', 'payments.request'], 'Your patient file, sick notes and bills from the clinic'],
        );
        const fee = Math.round(country().limits.demoCredit * 0.14 / 100) * 100;
        await db.query(
          `INSERT INTO payment_requests (partner_id, citizen_id, amount, reference, description, expires_at) VALUES ($1,$2,$3,'INV-1042','Consultation and tests', now() + interval '30 days')`,
          [p.id, firstCitizenId, fee],
        );
      }
      if (firstCitizenId && d.type === 'bank') {
        await db.query(
          `INSERT INTO consents (partner_id, citizen_id, subject, scopes, purpose, request_expires_at) VALUES ($1,$2,$3,$4,$5, now() + interval '30 days')`,
          [p.id, firstCitizenId, subjectFor(p.id, firstCitizenId), ['identity.basic', 'identity.kyc'], 'Open a savings account without visiting a branch'],
        );
      }
    }
    log(`demo partner ${d.tradingName} (${d.type}, ${d.status}) · portal ${d.email}${local ? ` / ${password}` : ''}${approved && local ? ` · API client demo-${d.type} / demo-${d.type}-secret` : ''}`);
  }
}

