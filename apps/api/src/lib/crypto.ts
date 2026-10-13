import { createHash, createHmac, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { country } from '../countries/index.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export const b64url = (b: Buffer) => b.toString('base64url');
export const randomToken = (bytes = 32) => b64url(randomBytes(bytes));
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const hmac = (s: string, key = config.secret) => createHmac('sha256', key).update(s).digest('hex');

/**
 * Keyed hash for a canonical national ID number: lets us find a citizen
 * without storing the number. The prefix keeps countries' hashes apart.
 */
export const hashIdentifier = (id: string) => hmac(country().nationalId.hashPrefix + id.replace(/\s+/g, ''));
/** Hash for bearer tokens (sessions, share links). */
export const hashToken = (t: string) => hmac('token:' + t);

export function otp(digits = 6): string {
  return String(randomInt(0, 10 ** digits)).padStart(digits, '0');
}

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Hash a PIN or password with scrypt and a random salt. Format: scrypt$<salt>$<hash>. */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const h = await scrypt(secret, salt, 32, SCRYPT);
  return `scrypt$${b64url(salt)}$${b64url(h)}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const h = await scrypt(secret, Buffer.from(salt, 'base64url'), 32, SCRYPT);
  const want = Buffer.from(hash, 'base64url');
  return want.length === h.length && timingSafeEqual(want, h);
}

/**
 * Compact signed token (HMAC-SHA256), used for selective-disclosure
 * presentations shown as QR codes. Format: base64url(json).base64url(sig).
 * In production this is replaced by an asymmetric signature (Ed25519 held in
 * the HSM) so verifiers can check offline with a public key.
 */
export function signPayload(payload: object): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = createHmac('sha256', config.secret).update('disclosure:' + body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyPayload<T = any>(token: string): T | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = createHmac('sha256', config.secret).update('disclosure:' + body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** Human-friendly reference like DL-2026-48213. */
export function reference(prefix: string): string {
  return `${prefix}-${new Date().getFullYear()}-${String(randomInt(10000, 99999))}`;
}
