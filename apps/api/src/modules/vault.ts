import type { Queryable } from '../db.js';
import { many, one } from '../db.js';
import { audit } from '../lib/audit.js';
import { hashToken, randomToken } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { notify } from '../lib/notify.js';

/** Document types a citizen can hold only one valid copy of. A new one supersedes the old. */
const SINGLETON = new Set(['omang', 'driver_licence', 'tax_clearance', 'passport']);

export interface IssueInput {
  type: string;
  title: string;
  issuerId: string;
  ref?: string | null;
  validTo?: Date | null;
  data?: Record<string, unknown>;
}

/** Issue a document straight into a citizen's Vault. Runs in the caller's transaction. */
export async function issueDocument(db: Queryable, citizenId: string, d: IssueInput, actor = 'system', opts: { notify?: boolean } = {}) {
  if (SINGLETON.has(d.type)) {
    await db.query(`UPDATE documents SET status = 'superseded' WHERE citizen_id = $1 AND type = $2 AND status = 'valid'`, [citizenId, d.type]);
  }
  const row = await one<any>(
    db,
    `INSERT INTO documents (citizen_id, type, title, issuer_id, ref, valid_to, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, issued_at`,
    [citizenId, d.type, d.title, d.issuerId, d.ref ?? null, d.validTo ?? null, JSON.stringify(d.data ?? {})],
  );
  await audit(db, actor, 'document.issued', `document:${row.id}`, { citizenId, type: d.type, issuer: d.issuerId, ref: d.ref ?? null });
  if (opts.notify !== false) await notify(db, citizenId, 'New document in your Vault', d.title, { sms: true });
  return row.id as string;
}

export async function listDocuments(db: Queryable, citizenId: string) {
  return many<any>(
    db,
    `SELECT d.id, d.type, d.title, d.ref, d.issued_at, d.valid_to, d.status, i.name AS issuer,
            (SELECT json_build_object('id', s.id, 'expiresAt', s.expires_at)
               FROM share_links s WHERE s.document_id = d.id AND s.revoked_at IS NULL AND s.expires_at > now()
              ORDER BY s.created_at DESC LIMIT 1) AS active_share
       FROM documents d JOIN issuers i ON i.id = d.issuer_id
      WHERE d.citizen_id = $1 AND d.status = 'valid'
      ORDER BY d.issued_at DESC`,
    [citizenId],
  );
}

/** Create a time-limited share link. The raw token is returned once and never stored. */
export async function createShareLink(db: Queryable, citizenId: string, documentId: string, hours: number) {
  if (!(hours >= 1 && hours <= 72)) throw badRequest('invalid_hours', 'A share link can last from 1 to 72 hours');
  const d = await one<any>(db, `SELECT id, title FROM documents WHERE id = $1 AND citizen_id = $2 AND status = 'valid'`, [documentId, citizenId]);
  if (!d) throw notFound('Document not found');
  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + hours * 3600_000);
  const s = await one<any>(
    db,
    'INSERT INTO share_links (document_id, citizen_id, token_hash, expires_at) VALUES ($1,$2,$3,$4) RETURNING id',
    [documentId, citizenId, hashToken(token), expiresAt],
  );
  await audit(db, `citizen:${citizenId}`, 'document.shared', `document:${documentId}`, { shareId: s.id, hours });
  return { id: s.id as string, token, expiresAt };
}

export async function revokeShareLink(db: Queryable, citizenId: string, shareId: string) {
  const r = await db.query('UPDATE share_links SET revoked_at = now() WHERE id = $1 AND citizen_id = $2 AND revoked_at IS NULL', [shareId, citizenId]);
  if (!r.rowCount) throw notFound('Share link not found');
  await audit(db, `citizen:${citizenId}`, 'document.share_revoked', `share:${shareId}`);
}

/** Resolve a public share token. Counts the view. Returns null if expired, revoked or unknown. */
export async function openShareLink(db: Queryable, token: string) {
  const r = await one<any>(
    db,
    `UPDATE share_links s SET views = views + 1
       FROM documents d, citizens c, issuers i
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND d.id = s.document_id AND c.id = s.citizen_id AND i.id = d.issuer_id AND d.status = 'valid'
      RETURNING d.title, d.type, d.ref, d.issued_at, d.valid_to, i.name AS issuer,
                c.first_name, c.last_name, c.omang_last4, s.expires_at, s.views`,
    [hashToken(token)],
  );
  return r;
}
