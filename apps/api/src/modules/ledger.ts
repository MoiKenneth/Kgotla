import type { Queryable } from '../db.js';
import { many, one } from '../db.js';
import { badRequest, conflict } from '../lib/errors.js';
import { fmt } from '../lib/money.js';

/**
 * Double-entry ledger.
 *
 * Sign convention: debit = positive, credit = negative, in thebe.
 * Citizen wallets are LIABILITY accounts (Kgotla owes the citizen), so a
 * wallet's balance is -(sum of postings). Paying from a wallet debits it;
 * receiving into a wallet credits it.
 *
 * Every entry balances to zero (enforced again by a deferred DB trigger),
 * postings are append-only (DB trigger), and an idempotency key makes a
 * retried request post at most once.
 */

export interface Line {
  account: string; // account code
  amount: number; // thebe, debit +, credit -
}

export interface EntryInput {
  kind: string;
  description: string;
  idempotencyKey?: string;
  meta?: Record<string, unknown>;
  lines: Line[];
}

export const walletCode = (citizenId: string) => `wallet:${citizenId}`;

export async function ensureWallet(db: Queryable, citizenId: string, name: string): Promise<void> {
  await db.query(
    `INSERT INTO ledger_accounts (code, kind, name, citizen_id) VALUES ($1,'liability',$2,$3)
     ON CONFLICT (code) DO NOTHING`,
    [walletCode(citizenId), `Wallet · ${name}`, citizenId],
  );
}

/** Create a system account if it does not exist (settlement, payables, revenue). */
export async function ensureAccount(db: Queryable, code: string, kind: string, name: string): Promise<void> {
  await db.query(
    `INSERT INTO ledger_accounts (code, kind, name, allow_negative) VALUES ($1,$2,$3,true) ON CONFLICT (code) DO NOTHING`,
    [code, kind, name],
  );
}

/** Wallet balance in thebe (positive = money the citizen has). */
export async function walletBalance(db: Queryable, citizenId: string): Promise<number> {
  const r = await one<{ b: number }>(
    db,
    `SELECT COALESCE(-SUM(p.amount),0)::bigint AS b
       FROM ledger_accounts a LEFT JOIN postings p ON p.account_id = a.id
      WHERE a.code = $1`,
    [walletCode(citizenId)],
  );
  return r?.b ?? 0;
}

/**
 * Post a balanced entry. Must run inside a transaction. Locks every involved
 * account in a fixed order (by id) to avoid deadlocks, then rejects the entry
 * if any citizen wallet would go below zero.
 * Returns the entry id; with a repeated idempotency key returns the original.
 */
export async function post(db: Queryable, e: EntryInput): Promise<{ entryId: string; replayed: boolean }> {
  if (e.lines.length < 2) throw badRequest('bad_entry', 'An entry needs at least two lines');
  const sum = e.lines.reduce((s, l) => s + l.amount, 0);
  if (sum !== 0) throw badRequest('bad_entry', 'Entry does not balance');
  if (e.lines.some((l) => !Number.isInteger(l.amount) || l.amount === 0)) throw badRequest('bad_entry', 'Amounts must be non-zero whole thebe');

  if (e.idempotencyKey) {
    const prev = await one<{ id: string }>(db, 'SELECT id FROM journal_entries WHERE idempotency_key = $1', [e.idempotencyKey]);
    if (prev) return { entryId: prev.id, replayed: true };
  }

  const codes = [...new Set(e.lines.map((l) => l.account))];
  const accts = await many<any>(
    db,
    'SELECT id, code, kind, citizen_id, allow_negative FROM ledger_accounts WHERE code = ANY($1) ORDER BY id FOR UPDATE',
    [codes],
  );
  if (accts.length !== codes.length) {
    const missing = codes.filter((c) => !accts.some((a) => a.code === c));
    throw badRequest('unknown_account', `Unknown ledger account: ${missing.join(', ')}`);
  }
  const byCode = new Map(accts.map((a) => [a.code, a]));

  const entry = await one<{ id: string }>(
    db,
    'INSERT INTO journal_entries (kind, description, idempotency_key, meta) VALUES ($1,$2,$3,$4) RETURNING id',
    [e.kind, e.description, e.idempotencyKey ?? null, JSON.stringify(e.meta ?? {})],
  );
  for (const l of e.lines) {
    await db.query('INSERT INTO postings (entry_id, account_id, amount) VALUES ($1,$2,$3)', [entry!.id, byCode.get(l.account).id, l.amount]);
  }

  // No citizen wallet may be overdrawn.
  for (const a of accts) {
    if (a.citizen_id && !a.allow_negative) {
      const b = await one<{ b: number }>(db, 'SELECT COALESCE(-SUM(amount),0)::bigint AS b FROM postings WHERE account_id = $1', [a.id]);
      if ((b?.b ?? 0) < 0) {
        throw conflict('insufficient_funds', 'There is not enough money in the wallet for this.');
      }
    }
  }
  return { entryId: entry!.id, replayed: false };
}

/** Wallet statement, newest first, with the signed effect on the citizen. */
export async function statement(db: Queryable, citizenId: string, limit = 30) {
  const rows = await many<any>(
    db,
    `SELECT e.id, e.kind, e.description, e.created_at, e.meta, -p.amount AS effect
       FROM postings p
       JOIN ledger_accounts a ON a.id = p.account_id
       JOIN journal_entries e ON e.id = p.entry_id
      WHERE a.code = $1
      ORDER BY e.created_at DESC, p.id DESC
      LIMIT $2`,
    [walletCode(citizenId), limit],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.description,
    at: r.created_at,
    amount: r.effect,
    amountText: (r.effect > 0 ? '+' : '') + fmt(r.effect),
  }));
}

/** Trial balance: the sum of every posting must be zero. */
export async function trialBalance(db: Queryable): Promise<number> {
  const r = await one<{ s: number }>(db, 'SELECT COALESCE(SUM(amount),0)::bigint AS s FROM postings');
  return r?.s ?? 0;
}
