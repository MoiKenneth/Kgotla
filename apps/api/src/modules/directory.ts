import { z } from 'zod';
import { country } from '../countries/index.js';
import { COUNTRY_DIRECTORY } from '../countries/directory.js';
import { many, one, type Queryable } from '../db.js';
import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';

/**
 * Directory of official portals (tax, banks, hospitals, utilities, tourism...).
 * Kgotla is the front door: an institution that has not connected yet is still
 * one tap away on its own official site, and its status shows what Kgotla can
 * do for the citizen directly.
 */

export const SECTORS = ['government', 'tax', 'banking', 'health', 'insurance', 'utilities', 'telecoms', 'education', 'tourism', 'transport', 'other'] as const;

export const entrySchema = z.object({
  name: z.string().trim().min(2).max(80),
  sector: z.enum(SECTORS),
  url: z.string().trim().url().max(300).refine((u) => u.startsWith('https://'), 'Use the institution’s https:// address'),
  description: z.string().trim().max(300).default(''),
  status: z.enum(['linked', 'connecting', 'connected']).default('linked'),
  partnerCode: z.string().trim().max(40).optional(),
});

export async function listDirectory(db: Queryable) {
  const rows = await many<any>(
    db,
    `SELECT d.id, d.name, d.sector, d.url, d.description, d.status, p.code AS partner_code, p.trading_name AS partner_name
       FROM directory_entries d LEFT JOIN partners p ON p.id = d.partner_id ORDER BY d.sector, d.name`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, sector: r.sector, url: r.url, description: r.description, status: r.status, partner: r.partner_code ? { code: r.partner_code, name: r.partner_name } : null }));
}

async function partnerIdFor(db: Queryable, code?: string) {
  if (!code) return null;
  const p = await one<any>(db, 'SELECT id FROM partners WHERE code = $1', [code]);
  if (!p) throw notFound(`No partner with code ${code}`);
  return p.id as string;
}

export async function saveEntry(db: Queryable, officerId: string, e: z.infer<typeof entrySchema>, id?: string) {
  const partnerId = await partnerIdFor(db, e.partnerCode);
  try {
    const r = id
      ? await one<any>(db, 'UPDATE directory_entries SET name=$2, sector=$3, url=$4, description=$5, status=$6, partner_id=$7 WHERE id=$1 RETURNING id', [id, e.name, e.sector, e.url, e.description, e.status, partnerId])
      : await one<any>(db, 'INSERT INTO directory_entries (name, sector, url, description, status, partner_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [e.name, e.sector, e.url, e.description, e.status, partnerId]);
    if (!r) throw notFound('Directory entry not found');
    await audit(db, `officer:${officerId}`, id ? 'directory.updated' : 'directory.added', `directory:${r.id}`, { name: e.name, status: e.status });
    return { id: r.id as string };
  } catch (x: any) {
    if (x?.code === '23505') throw conflict('duplicate', 'An entry with that name already exists');
    throw x;
  }
}

export async function deleteEntry(db: Queryable, officerId: string, id: string) {
  const r = await db.query('DELETE FROM directory_entries WHERE id = $1', [id]);
  if (!r.rowCount) throw notFound('Directory entry not found');
  await audit(db, `officer:${officerId}`, 'directory.removed', `directory:${id}`);
}

/** Starting entries for this country. Added once; admins edit them afterwards. */
export async function seedDirectory(db: Queryable) {
  for (const e of COUNTRY_DIRECTORY[country().code]) {
    await db.query('INSERT INTO directory_entries (name, sector, url, description) VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO NOTHING', [e.name, e.sector, e.url, e.description]);
  }
}
