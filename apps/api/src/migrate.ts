import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { createPool } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
// Works from src/ (tsx) and dist/src/ (compiled).
const candidates = [join(here, '..', 'migrations'), join(here, '..', '..', 'migrations')];

export async function migrate(pool: pg.Pool, log = console.log): Promise<void> {
  const dir = candidates.find((d) => {
    try {
      return readdirSync(d).length > 0;
    } catch {
      return false;
    }
  });
  if (!dir) throw new Error('migrations folder not found');
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await pool.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(readFileSync(join(dir, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
      await c.query('COMMIT');
      log(`migrated ${f}`);
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pool = createPool();
  migrate(pool)
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
