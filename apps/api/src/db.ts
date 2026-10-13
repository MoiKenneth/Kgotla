import pg from 'pg';
import { config } from './config.js';

// Return BIGINT (int8) as JS number. Ledger amounts are minor units and stay far
// below 2^53 (about 90 trillion in major units), so this is safe and keeps code simple.
pg.types.setTypeParser(20, (v) => Number(v));
// NUMERIC as number (scores).
pg.types.setTypeParser(1700, (v) => Number(v));
// DATE as plain 'YYYY-MM-DD' string, never shifted by time zone.
pg.types.setTypeParser(1082, (v) => v);

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

/**
 * Microsoft Entra token for Azure Database for PostgreSQL, fetched with the
 * cell's managed identity and cached until five minutes before it expires.
 * The database never sees a stored password.
 */
let cached: { token: string; expires: number } | null = null;
async function entraToken(): Promise<string> {
  if (cached && cached.expires - Date.now() > 5 * 60_000) return cached.token;
  const { ManagedIdentityCredential } = await import('@azure/identity');
  const cred = config.azureClientId ? new ManagedIdentityCredential({ clientId: config.azureClientId }) : new ManagedIdentityCredential();
  const t = await cred.getToken('https://ossrdbms-aad.database.windows.net/.default');
  if (!t) throw new Error('Could not get a Microsoft Entra token for PostgreSQL');
  cached = { token: t.token, expires: t.expiresOnTimestamp };
  return t.token;
}

export function createPool(url = config.databaseUrl): pg.Pool {
  const base: pg.PoolConfig = { max: 10 };
  // With no URL, node-postgres reads PGHOST, PGUSER, PGDATABASE, PGPORT and PGSSLMODE.
  if (url) base.connectionString = url;
  if (config.dbAuth === 'entra' && !url) base.password = entraToken;
  return new pg.Pool(base);
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
