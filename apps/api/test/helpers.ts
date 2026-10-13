import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { useCountry } from '../src/countries/index.js';
import { assertCell, migrate } from '../src/migrate.js';
import { seedDemo, seedReference } from '../src/seed.js';
import type { LlmClient } from '../src/modules/assistant.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5433/kgotla_test';

export const NALEDI = { omang: '435721904', pin: '2580', phone: '+26771234558' };
export const MPHO = { omang: '512810117', pin: '1357', phone: '+26772345614' };
export const KABELO = { omang: '287410556', pin: '2468', phone: '+26774345630' };

export interface Harness {
  pool: pg.Pool;
  app: FastifyInstance;
  close(): Promise<void>;
}

/** Fresh schema + reference and demo data for one country cell, then an in-process app. */
export async function harness(opts: { llm?: LlmClient | null; country?: string } = {}): Promise<Harness> {
  const pack = useCountry(opts.country ?? 'BW');
  const pool = createPool(TEST_DB);
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS registry_mock CASCADE; CREATE SCHEMA public;');
  const quiet = () => undefined;
  await migrate(pool, quiet);
  await assertCell(pool, pack.code);
  await seedReference(pool, quiet);
  await seedDemo(pool, quiet);
  const app = await buildApp({ pool, llm: opts.llm ?? null });
  await app.ready();
  return {
    pool,
    app,
    async close() {
      await app.close();
      await pool.end();
    },
  };
}

export async function login(app: FastifyInstance, who: { omang: string; pin: string }): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { nationalId: who.omang, pin: who.pin } });
  if (r.statusCode !== 200) throw new Error(`login failed ${r.statusCode} ${r.body}`);
  return r.json().token;
}

export async function officerLogin(app: FastifyInstance, username: string): Promise<string> {
  // Demo officers share one password in tests.
  const r = await app.inject({ method: 'POST', url: '/v1/officer/login', payload: { username, password: 'kgotla-demo' } });
  if (r.statusCode !== 200) throw new Error(`officer login failed ${r.body}`);
  return r.json().token;
}

export const auth = (t: string) => ({ authorization: `Bearer ${t}` });

export async function call(app: FastifyInstance, token: string | null, method: string, url: string, payload?: unknown) {
  const r = await app.inject({ method: method as any, url, payload: payload as any, headers: token ? auth(token) : {} });
  let json: any = null;
  try {
    json = r.json();
  } catch {
    json = r.body;
  }
  return { status: r.statusCode, json };
}

export async function balance(app: FastifyInstance, token: string): Promise<number> {
  return (await call(app, token, 'GET', '/v1/me')).json.balance;
}
