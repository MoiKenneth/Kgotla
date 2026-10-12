import pg from 'pg';
import { config } from './config.js';

// Return BIGINT (int8) as JS number. Ledger amounts are thebe and stay far
// below 2^53 (about 90 trillion pula), so this is safe and keeps code simple.
pg.types.setTypeParser(20, (v) => Number(v));
// NUMERIC as number (scores).
pg.types.setTypeParser(1700, (v) => Number(v));
// DATE as plain 'YYYY-MM-DD' string, never shifted by time zone.
pg.types.setTypeParser(1082, (v) => v);

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export function createPool(url = config.databaseUrl): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}

/** Run fn inside a transaction. Rolls back on any thrown error. */
export async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export async function one<T = any>(db: Queryable, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await db.query(sql, params as any[]);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = any>(db: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query(sql, params as any[]);
  return r.rows as T[];
}
