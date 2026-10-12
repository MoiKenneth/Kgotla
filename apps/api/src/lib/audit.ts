import type { Queryable } from '../db.js';
import { many, one } from '../db.js';
import { sha256 } from './crypto.js';

const GENESIS = '0'.repeat(64);

/** JSON with sorted object keys, so the hash survives jsonb's key reordering. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + canonical((v as any)[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}

function rowHash(prev: string, at: string, actor: string, action: string, subject: string | null, data: unknown) {
  return sha256(canonical([prev, at, actor, action, subject, data]));
}

/**
 * Append to the hash-chained audit log. Must run inside a transaction: an
 * advisory lock serialises writers so the chain never forks.
 */
export async function audit(
  db: Queryable,
  actor: string,
  action: string,
  subject: string | null = null,
  data: Record<string, unknown> = {},
): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(7314001)');
  const last = await one<{ hash: string }>(db, 'SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
  const prev = last?.hash ?? GENESIS;
  const at = new Date().toISOString();
  const hash = rowHash(prev, at, actor, action, subject, data);
  await db.query(
    'INSERT INTO audit_log (at, actor, action, subject, data, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [at, actor, action, subject, JSON.stringify(data), prev, hash],
  );
}

/** Recompute the whole chain. Returns the id of the first broken row, or null if intact. */
export async function verifyAuditChain(db: Queryable): Promise<number | null> {
  const rows = await many<any>(db, 'SELECT id, at, actor, action, subject, data, prev_hash, hash FROM audit_log ORDER BY id');
  let prev = GENESIS;
  for (const r of rows) {
    const at = new Date(r.at).toISOString();
    if (r.prev_hash !== prev || rowHash(prev, at, r.actor, r.action, r.subject, r.data) !== r.hash) return Number(r.id);
    prev = r.hash;
  }
  return null;
}
