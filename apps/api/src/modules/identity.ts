import type pg from 'pg';
import { config } from '../config.js';
import { country } from '../countries/index.js';
import { one, tx, type Queryable } from '../db.js';
import { audit } from '../lib/audit.js';
import { createSession } from '../lib/auth.js';
import { hashIdentifier, hashSecret, otp, signPayload, verifyPayload, hashToken } from '../lib/crypto.js';
import { badRequest, conflict, notFound, unauthorized } from '../lib/errors.js';
import { enqueue } from '../lib/notify.js';
import { ensureAccount, ensureWallet, post, walletCode } from './ledger.js';
import { issueDocument } from './vault.js';

// ---------------------------------------------------------------------------
// Adapters. Production implementations call the national registry over the
// government data exchange, and a certified liveness/face-match vendor.
// ---------------------------------------------------------------------------

export interface RegistryPerson {
  omang: string;
  firstName: string;
  lastName: string;
  dob: string;
  sex: 'F' | 'M';
  district: string;
  phone: string;
  licenceClass: string | null;
  licenceValidTo: string | null;
  taxCompliant: boolean;
}

export interface Registry {
  lookup(omang: string): Promise<RegistryPerson | null>;
  /** Find by the keyed Omang hash we store (production: the exchange resolves our pseudonymous reference). */
  findByHash(omangHash: string): Promise<RegistryPerson | null>;
}

export class MockRegistry implements Registry {
  constructor(private db: Queryable) {}
  async findByHash(omangHash: string) {
    const rows = await (this.db as any).query('SELECT omang FROM registry_mock.people');
    const hit = rows.rows.find((r: any) => hashIdentifier(r.omang) === omangHash);
    return hit ? this.lookup(hit.omang) : null;
  }
  async lookup(omang: string): Promise<RegistryPerson | null> {
    const r = await one<any>(this.db, 'SELECT * FROM registry_mock.people WHERE omang = $1', [omang]);
    if (!r) return null;
    return {
      omang: r.omang,
      firstName: r.first_name,
      lastName: r.last_name,
      dob: r.dob,
      sex: r.sex,
      district: r.district,
      phone: r.phone,
      licenceClass: r.licence_class,
      licenceValidTo: r.licence_valid_to,
      taxCompliant: r.tax_compliant,
    };
  }
}

export interface Liveness {
  /** Returns liveness confidence and 1:1 match against the registry photo, both 0..1. */
  check(selfie: Buffer, omang: string): Promise<{ liveness: number; match: number }>;
}

/** Development liveness: accepts any real image (>2 KB). Never use in a pilot. */
export class MockLiveness implements Liveness {
  async check(selfie: Buffer) {
    if (selfie.length < 2048) return { liveness: 0.1, match: 0 };
    return { liveness: 0.97, match: 0.986 };
  }
}

const LIVENESS_MIN = 0.9;
const MATCH_MIN = 0.92;

/** Validate and canonicalise a national ID number using this cell's rules. */
export function nationalId(raw: string): string {
  const id = country().nationalId.normalise(String(raw ?? ''));
  if (!id) throw badRequest('invalid_national_id', country().nationalId.error);
  return id;
}

/** "+267 71 •• •• 58": enough to recognise a number, not enough to misuse it. */
export function maskPhone(p: string): string {
  const { cc } = country().phone;
  const nsn = p.startsWith('+' + cc) ? p.slice(cc.length + 1) : p.replace(/^\+\d{1,3}/, '');
  return `+${cc} ${nsn.slice(0, 2)} •• •• ${nsn.slice(-2)}`;
}

/** Normalise a mobile number to E.164 (+CC + national number) for this cell. */
export function normalisePhone(p: string): string {
  const { cc, nsn, trunk, example } = country().phone;
  const d = String(p ?? '').replace(/[^\d+]/g, '');
  const national = new RegExp(`^\\d{${nsn}}$`);
  if (d.startsWith('+' + cc) && national.test(d.slice(cc.length + 1))) return d;
  if (d.startsWith(cc) && national.test(d.slice(cc.length))) return '+' + d;
  if (trunk && d.startsWith('0') && national.test(d.slice(1))) return `+${cc}${d.slice(1)}`;
  if (national.test(d)) return `+${cc}${d}`;
  throw badRequest('invalid_phone', `Enter a ${country().name} mobile number, like ${example}`);
}

// ---------------------------------------------------------------------------
// Enrolment: Omang + SMS OTP + liveness/face match + PIN = assurance level 3
// ---------------------------------------------------------------------------

/** Details a person declares when there is no registry link yet (open sign-up). */
export interface Declared { firstName: string; lastName: string; dob: string; phone: string; district: string }

function declaredPerson(omang: string, d: Declared): RegistryPerson {
  const name = (s: string) => s.trim().replace(/\s+/g, ' ');
  if (!name(d.firstName) || !name(d.lastName)) throw badRequest('name_required', 'Enter your first name and surname as they appear on your ID');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.dob) || isNaN(Date.parse(d.dob))) throw badRequest('invalid_dob', 'Enter your date of birth');
  const age = (Date.now() - Date.parse(d.dob)) / (365.25 * 86400_000);
  if (age < 16 || age > 120) throw badRequest('invalid_dob', 'You must be 16 or older to open a Kgotla account');
  return {
    omang, firstName: name(d.firstName), lastName: name(d.lastName), dob: d.dob, sex: 'F', district: name(d.district || '') || country().name,
    phone: normalisePhone(d.phone), licenceClass: null, licenceValidTo: null, taxCompliant: false,
  };
}

/**
 * Start sign-up. With a registry link (or the demo registry) the details come from
 * the registry; in open mode the person declares them and proves their phone.
 */
export async function startEnrolment(pool: pg.Pool, registry: Registry, idRaw: string, declared?: Declared) {
  const omang = nationalId(idRaw);
  const idName = country().nationalId.name;
  const open = config.registryMode === 'open';
  if (open && !declared) throw badRequest('details_required', 'Enter your name, date of birth and mobile number');
  const person = open ? declaredPerson(omang, declared!) : await registry.lookup(omang);
  if (!person) throw notFound(`We could not find that ${idName} in the national registry. Check it and try again.`);
  const omangHash = hashIdentifier(omang);
  if (await one(pool, 'SELECT 1 FROM citizens WHERE omang_hash = $1', [omangHash])) {
    throw conflict('already_enrolled', `This ${idName} already has a Kgotla account. Sign in with your PIN.`);
  }
  if (open && (await one(pool, 'SELECT 1 FROM citizens WHERE phone = $1', [person.phone]))) {
    throw conflict('phone_in_use', 'That mobile number already belongs to a Kgotla account');
  }
  const code = otp();
  const e = await tx(pool, async (c) => {
    const row = await one<any>(
      c,
      `INSERT INTO enrolments (omang_hash, omang, otp_hash, expires_at, declared) VALUES ($1,$2,$3, now() + interval '20 minutes', $4) RETURNING id`,
      [omangHash, omang, hashToken(code), open ? JSON.stringify(person) : null],
    );
    await enqueue(c, 'sms.phone', { phone: person.phone, text: `Kgotla code: ${code}. Never share it. Valid 20 minutes.` });
    return row;
  });
  return {
    enrolmentId: e.id as string,
    phoneMasked: maskPhone(person.phone),
    firstName: person.firstName,
    ...(config.demoMode ? { demoOtp: code } : {}),
  };
}

async function liveEnrolment(db: Queryable, id: string) {
  const e = await one<any>(db, 'SELECT * FROM enrolments WHERE id = $1 AND completed_at IS NULL AND expires_at > now() FOR UPDATE', [id]);
  if (!e) throw notFound('This sign-up has expired. Start again.');
  return e;
}

export async function verifyEnrolmentOtp(pool: pg.Pool, id: string, code: string) {
  return tx(pool, async (c) => {
    const e = await liveEnrolment(c, id);
    if (e.otp_attempts >= 5) throw badRequest('too_many_attempts', 'Too many wrong codes. Start again.');
    if (hashToken(String(code ?? '').trim()) !== e.otp_hash) {
      await c.query('UPDATE enrolments SET otp_attempts = otp_attempts + 1 WHERE id = $1', [id]);
      return { ok: false as const, attemptsLeft: 4 - e.otp_attempts };
    }
    await c.query('UPDATE enrolments SET otp_verified = true WHERE id = $1', [id]);
    return { ok: true as const };
  });
}

export async function enrolmentLiveness(pool: pg.Pool, liveness: Liveness, id: string, selfieB64: string) {
  const img = Buffer.from(String(selfieB64 ?? '').replace(/^data:image\/\w+;base64,/, ''), 'base64');
  if (img.length > 3 * 1024 * 1024) throw badRequest('image_too_large', 'The photo is too large');
  return tx(pool, async (c) => {
    const e = await liveEnrolment(c, id);
    if (!e.otp_verified) throw badRequest('otp_required', 'Confirm the SMS code first');
    const r = await liveness.check(img, e.omang);
    // Open sign-up has no registry photo to match against: only liveness counts, and the account gets assurance level 2.
    const match = e.declared ? 1 : r.match;
    await c.query('UPDATE enrolments SET liveness_score = $2, face_match = $3 WHERE id = $1', [id, r.liveness, match]);
    // The selfie itself is never stored.
    return { passed: r.liveness >= LIVENESS_MIN && match >= MATCH_MIN, match };
  });
}

/** Finish enrolment: create the citizen, wallet and Vault, return a session. */
export async function completeEnrolment(
  pool: pg.Pool,
  registry: Registry,
  id: string,
  input: { pin: string; deviceLabel?: string; lang?: string },
) {
  if (!/^\d{4}$/.test(String(input.pin ?? ''))) throw badRequest('invalid_pin', 'Choose a 4-digit PIN');
  if (/^(\d)\1{3}$/.test(input.pin) || ['1234', '4321', '0000'].includes(input.pin) && !config.demoMode) {
    throw badRequest('weak_pin', 'Choose a PIN that is harder to guess');
  }
  const pinHash = await hashSecret(input.pin);
  return tx(pool, async (c) => {
    const e = await liveEnrolment(c, id);
    if (!e.otp_verified) throw badRequest('otp_required', 'Confirm the SMS code first');
    if (!(e.liveness_score >= LIVENESS_MIN && e.face_match >= MATCH_MIN)) throw badRequest('liveness_required', 'Complete the face check first');
    const p: RegistryPerson | null = e.declared ?? (await registry.lookup(e.omang));
    if (!p) throw notFound('Registry record not found');
    // Level 3: registry match + face match. Level 2: phone proven, identity declared (open sign-up).
    const loa = e.declared ? 2 : 3;
    let citizen: any;
    try {
      citizen = await one<any>(
        c,
        `INSERT INTO citizens (omang_hash, omang_last4, first_name, last_name, dob, district, phone, loa, pin_hash, lang)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [e.omang_hash, e.omang.replace(/\W/g, '').slice(-4), p.firstName, p.lastName, p.dob, p.district, p.phone, loa, pinHash, supportedLang(input.lang)],
      );
    } catch (x: any) {
      if (x?.code === '23505') throw conflict('already_enrolled', 'This ID or mobile number already has a Kgotla account. Sign in with your PIN.');
      throw x;
    }
    // Clear the raw Omang from the enrolment record.
    await c.query(`UPDATE enrolments SET completed_at = now(), omang = '' WHERE id = $1`, [id]);
    await provisionCitizen(c, citizen.id, p, { verified: loa === 3 });
    await audit(c, `citizen:${citizen.id}`, 'citizen.enrolled', `citizen:${citizen.id}`, { loa, match: e.face_match, mode: e.declared ? 'open' : 'registry' });
    const s = await createSession(c, 'citizen', citizen.id, input.deviceLabel);
    return { citizenId: citizen.id as string, token: s.token, expiresAt: s.expiresAt };
  });
}

/** A language this cell's app is translated into, else the first one. */
export function supportedLang(lang?: string): string {
  const langs = country().languages.map((l) => l.code);
  return lang && langs.includes(lang) ? lang : langs[0];
}

/** Wallet, national ID credential and registry-held documents for a new citizen. */
export async function provisionCitizen(db: Queryable, citizenId: string, p: RegistryPerson, opts: { verified?: boolean } = {}) {
  const pack = country();
  await ensureWallet(db, citizenId, `${p.firstName} ${p.lastName}`);
  // Only a registry-verified identity gets the national ID credential in the Vault.
  if (opts.verified !== false) await issueDocument(db, citizenId, {
    type: 'omang',
    title: pack.nationalId.documentTitle,
    issuerId: pack.agencies.civil.code,
    ref: `***${p.omang.replace(/\W/g, '').slice(-4)}`,
    validTo: new Date(Date.now() + 5 * 365 * 86400_000),
  }, 'system', { notify: false });
  if (p.licenceClass && p.licenceValidTo) {
    const lic = pack.services.find((s) => s.code === 'driver_licence_renewal')!;
    await issueDocument(db, citizenId, {
      type: 'driver_licence',
      title: lic.output.title.replace('{licence_class}', p.licenceClass),
      issuerId: lic.output.issuer,
      validTo: new Date(`${p.licenceValidTo}T23:59:59${pack.utcOffset}`),
      data: { licence_class: p.licenceClass },
    }, 'system', { notify: false });
  }
  if (config.demoMode) {
    const credit = pack.limits.demoCredit;
    await ensureAccount(db, 'settlement:demo_float', 'asset', 'Demo float (not real money)');
    await post(db, {
      kind: 'demo_credit',
      description: 'Demo credit (example money)',
      idempotencyKey: `demo-credit:${citizenId}`,
      lines: [
        { account: 'settlement:demo_float', amount: credit },
        { account: walletCode(citizenId), amount: -credit },
      ],
    });
  }
}

export async function login(pool: pg.Pool, idRaw: string, pin: string, deviceLabel?: string) {
  const omang = nationalId(idRaw);
  const c = await one<any>(pool, 'SELECT id FROM citizens WHERE omang_hash = $1', [hashIdentifier(omang)]);
  if (!c) throw unauthorized(`${country().nationalId.name} or PIN is not correct`);
  const { verifyPin } = await import('../lib/auth.js');
  await verifyPin(pool, c.id, pin);
  const s = await tx(pool, async (db) => {
    await audit(db, `citizen:${c.id}`, 'citizen.login', `citizen:${c.id}`, { device: deviceLabel ?? null });
    return createSession(db, 'citizen', c.id, deviceLabel);
  });
  return { citizenId: c.id as string, ...s };
}

export async function profile(db: Queryable, citizenId: string) {
  const c = await one<any>(db, 'SELECT id, first_name, last_name, dob, district, phone, loa, lang, omang_last4, created_at FROM citizens WHERE id = $1', [citizenId]);
  if (!c) throw notFound('Citizen not found');
  return {
    id: c.id,
    firstName: c.first_name,
    lastName: c.last_name,
    dob: c.dob,
    district: c.district,
    phoneMasked: maskPhone(c.phone),
    loa: c.loa,
    lang: supportedLang(c.lang),
    idLast4: c.omang_last4,
    omangLast4: c.omang_last4, // deprecated alias of idLast4
    memberSince: c.created_at,
  };
}

// ---------------------------------------------------------------------------
// Selective disclosure: show a verifier only the claims the citizen chose.
// ---------------------------------------------------------------------------

export const CLAIMS = ['name', 'photo', 'dob', 'over18', 'district', 'id_last4'] as const;
export type Claim = (typeof CLAIMS)[number];

export async function createDisclosure(db: Queryable, citizenId: string, claims: string[], audience = 'QR verifier') {
  // 'omang_last4' is accepted as the Phase 1 name of 'id_last4'.
  const wanted = [...new Set(claims.map((c) => (c === 'omang_last4' ? 'id_last4' : c)))].filter((c): c is Claim => (CLAIMS as readonly string[]).includes(c));
  if (!wanted.length) throw badRequest('no_claims', 'Choose at least one detail to share');
  if (wanted.includes('dob') && wanted.includes('over18')) throw badRequest('redundant', 'Share either date of birth or over-18, not both');
  const c = await one<any>(db, 'SELECT first_name, last_name, dob, district, omang_last4, loa FROM citizens WHERE id = $1', [citizenId]);
  if (!c) throw notFound('Citizen not found');
  const values: Record<string, unknown> = {};
  for (const k of wanted) {
    if (k === 'name') values.name = `${c.first_name} ${c.last_name}`;
    if (k === 'dob') values.dob = c.dob;
    if (k === 'over18') values.over18 = ageOn(c.dob, new Date()) >= 18;
    if (k === 'district') values.district = c.district;
    if (k === 'id_last4') values.id_last4 = c.omang_last4;
    if (k === 'photo') values.photo = 'registry-photo-reference'; // a verifier app fetches it from the registry with this disclosure
  }
  const ttl = 120;
  const d = await one<any>(
    db,
    `INSERT INTO disclosures (citizen_id, audience, claims, expires_at) VALUES ($1,$2,$3, now() + make_interval(secs => $4)) RETURNING id, expires_at`,
    [citizenId, audience, JSON.stringify(wanted), ttl],
  );
  const token = signPayload({ v: 1, jti: d.id, iss: `kgotla-${country().code.toLowerCase()}`, country: country().code, loa: c.loa, claims: values, exp: Math.floor(new Date(d.expires_at).getTime() / 1000) });
  await audit(db, `citizen:${citizenId}`, 'disclosure.created', `disclosure:${d.id}`, { claims: wanted });
  return { id: d.id as string, token, qr: `KGOTLA1:${token}`, expiresAt: d.expires_at as Date, claims: wanted };
}

export async function verifyDisclosure(db: Queryable, raw: string) {
  const token = String(raw ?? '').replace(/^KGOTLA1:/, '').trim();
  const p = verifyPayload<any>(token);
  if (!p || p.v !== 1) return { valid: false as const, reason: 'This code was not issued by Kgotla or was altered.' };
  if (p.exp * 1000 < Date.now()) return { valid: false as const, reason: 'This code has expired. Ask for a new one.' };
  const d = await one<any>(db, `UPDATE disclosures SET verified_at = COALESCE(verified_at, now()) WHERE id = $1 RETURNING citizen_id`, [p.jti]);
  if (!d) return { valid: false as const, reason: 'Unknown code' };
  return { valid: true as const, country: p.country ?? 'BW', assuranceLevel: p.loa, claims: p.claims, expiresAt: new Date(p.exp * 1000) };
}

export function ageOn(dob: string, at: Date): number {
  const [y, m, d] = dob.split('-').map(Number);
  let age = at.getUTCFullYear() - y;
  if (at.getUTCMonth() + 1 < m || (at.getUTCMonth() + 1 === m && at.getUTCDate() < d)) age--;
  return age;
}
