import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { config } from '../config.js';
import type { Queryable } from '../db.js';
import { one } from '../db.js';
import { hashToken, randomToken, verifySecret } from './crypto.js';
import { forbidden, locked, unauthorized } from './errors.js';

export type Principal =
  | { type: 'citizen'; id: string; sessionId: string }
  | { type: 'officer'; id: string; sessionId: string; agency: string; role: string }
  | { type: 'partner'; id: string; sessionId: string; via: 'portal' | 'api'; status: string };

export type SubjectType = 'citizen' | 'officer' | 'partner_portal' | 'partner_api';

export async function createSession(
  db: Queryable,
  subjectType: SubjectType,
  subjectId: string,
  deviceLabel?: string,
  ttlHours = config.sessionTtlHours,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
  await db.query(
    'INSERT INTO sessions (token_hash, subject_type, subject_id, device_label, expires_at) VALUES ($1,$2,$3,$4,$5)',
    [hashToken(token), subjectType, subjectId, deviceLabel ?? null, expiresAt],
  );
  return { token, expiresAt };
}

export async function resolvePrincipal(pool: pg.Pool, req: FastifyRequest): Promise<Principal | null> {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  const s = await one<any>(
    pool,
    `SELECT s.id, s.subject_type, s.subject_id, o.agency, o.role, p.status AS partner_status
       FROM sessions s
       LEFT JOIN officers o ON s.subject_type = 'officer' AND o.id = s.subject_id
       LEFT JOIN partners p ON s.subject_type IN ('partner_portal','partner_api') AND p.id = s.subject_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [hashToken(h.slice(7).trim())],
  );
  if (!s) return null;
  if (s.subject_type === 'citizen') return { type: 'citizen', id: s.subject_id, sessionId: s.id };
  if (s.subject_type === 'partner_api') {
    // API tokens stop working the moment a partner is suspended.
    if (s.partner_status !== 'approved') return null;
    return { type: 'partner', id: s.subject_id, sessionId: s.id, via: 'api', status: s.partner_status };
  }
  if (s.subject_type === 'partner_portal') return { type: 'partner', id: s.subject_id, sessionId: s.id, via: 'portal', status: s.partner_status };
  return { type: 'officer', id: s.subject_id, sessionId: s.id, agency: s.agency, role: s.role };
}

export function citizenOf(req: FastifyRequest): string {
  const p = (req as any).principal as Principal | null;
  if (!p) throw unauthorized();
  if (p.type !== 'citizen') throw forbidden('This is for citizens');
  return p.id;
}

export function officerOf(req: FastifyRequest, roles?: string[]) {
  const p = (req as any).principal as Principal | null;
  if (!p) throw unauthorized();
  if (p.type !== 'officer') throw forbidden('This is for government officers');
  if (roles && !roles.includes(p.role) && p.role !== 'admin') throw forbidden('Your role cannot do this');
  return p;
}

/** The partner behind a request: 'api' for OAuth access tokens, 'portal' for the partner portal. */
export function partnerOf(req: FastifyRequest, via: 'api' | 'portal') {
  const p = (req as any).principal as Principal | null;
  if (!p) throw unauthorized(via === 'api' ? 'Send a valid access token from /v1/oauth/token' : 'Sign in to the partner portal');
  if (p.type !== 'partner' || p.via !== via) throw forbidden(via === 'api' ? 'This needs a partner API access token' : 'This is for the partner portal');
  return p;
}

/**
 * Check a citizen's PIN with lockout. Runs in the caller's transaction and
 * locks the citizen row, so parallel guesses cannot bypass the counter.
 */
export async function checkPin(db: Queryable, citizenId: string, pin: string): Promise<void> {
  const c = await one<any>(db, 'SELECT pin_hash, pin_failures, locked_until FROM citizens WHERE id = $1 FOR UPDATE', [citizenId]);
  if (!c) throw unauthorized();
  if (c.locked_until && new Date(c.locked_until) > new Date()) {
    throw locked(`Too many wrong PINs. Try again after ${new Date(c.locked_until).toISOString()}.`);
  }
  if (!/^\d{4,6}$/.test(pin) || !(await verifySecret(pin, c.pin_hash))) {
    const failures = c.pin_failures + 1;
    const lock = failures >= config.pinMaxFailures ? new Date(Date.now() + config.pinLockMinutes * 60_000) : null;
    await db.query('UPDATE citizens SET pin_failures = $2, locked_until = $3 WHERE id = $1', [
      citizenId,
      lock ? 0 : failures,
      lock,
    ]);
    // Persist the failure even though we are about to throw: caller commits on PinError.
    throw new PinError(lock ? 'Too many wrong PINs. Your PIN is locked for ' + config.pinLockMinutes + ' minutes.' : `Wrong PIN. ${config.pinMaxFailures - failures} tries left.`);
  }
  if (c.pin_failures > 0) await db.query('UPDATE citizens SET pin_failures = 0 WHERE id = $1', [citizenId]);
}

/**
 * Verify a PIN in its own transaction so a wrong attempt is always counted,
 * even when the operation it guards is later rolled back.
 */
export async function verifyPin(pool: pg.Pool, citizenId: string, pin: string): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await checkPin(c, citizenId, String(pin ?? ''));
    await c.query('COMMIT');
  } catch (e) {
    await c.query(e instanceof PinError ? 'COMMIT' : 'ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Thrown for a wrong PIN. Callers commit the transaction so the failure counter sticks. */
export class PinError extends Error {
  status = 401;
  code = 'wrong_pin';
}
