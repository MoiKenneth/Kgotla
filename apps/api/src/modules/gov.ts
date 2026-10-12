import type { Queryable } from '../db.js';
import { many, one } from '../db.js';
import { audit } from '../lib/audit.js';
import { reference } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { fmt } from '../lib/money.js';
import { notify } from '../lib/notify.js';
import { post, walletCode } from './ledger.js';
import { issueDocument } from './vault.js';

/**
 * Government service engine. Each service is DATA (a template row: agency,
 * fee, ordered steps, the document issued at the end), so a ministry can add
 * a service without a code release. Applications move forward one step at a
 * time by a case worker of the owning agency; the final step issues the
 * output document into the citizen's Vault.
 */

export interface Step {
  key: string;
  label: string;
  label_tn?: string;
}
export interface Template {
  code: string;
  name: string;
  agency: string;
  fee: number;
  steps: Step[];
  output: null | { type: string; title: string; issuer: string; validYears?: number; validDays?: number };
}

export const agencyAccount = (agency: string) => `payable:agency:${agency}`;

export async function getTemplate(db: Queryable, code: string): Promise<Template> {
  const t = await one<Template>(db, 'SELECT code, name, agency, fee, steps, output FROM service_templates WHERE code = $1 AND active', [code]);
  if (!t) throw notFound('Unknown service');
  return t;
}

const fill = (s: string, data: Record<string, any>) => s.replace(/\{(\w+)\}/g, (_, k) => String(data[k] ?? ''));

/** Open an application and charge its fee. Runs in the caller's transaction. */
export async function openApplication(
  db: Queryable,
  citizenId: string,
  code: string,
  data: Record<string, unknown>,
  actor: string,
): Promise<{ id: string; ref: string }> {
  const t = await getTemplate(db, code);
  const prefix = { driver_licence_renewal: 'DL', birth_certificate_copy: 'BC', tax_clearance: 'TC' }[code] ?? 'AP';
  const ref = reference(prefix);
  const app = await one<{ id: string }>(
    db,
    'INSERT INTO applications (ref, citizen_id, template_code, data) VALUES ($1,$2,$3,$4) RETURNING id',
    [ref, citizenId, code, JSON.stringify(data)],
  );
  if (t.fee > 0) {
    await post(db, {
      kind: 'gov_fee',
      description: `${t.name} · ${ref}`,
      idempotencyKey: `fee:${app!.id}`,
      meta: { applicationId: app!.id, agency: t.agency },
      lines: [
        { account: walletCode(citizenId), amount: t.fee },
        { account: agencyAccount(t.agency), amount: -t.fee },
      ],
    });
  }
  await db.query('INSERT INTO application_events (application_id, step, actor, note) VALUES ($1,0,$2,$3)', [app!.id, actor, 'Submitted']);
  await audit(db, actor, 'application.opened', `application:${app!.id}`, { ref, code, fee: t.fee });
  await notify(db, citizenId, `${t.name}: submitted`, `Reference ${ref}${t.fee ? `. Fee ${fmt(t.fee)} paid.` : '.'}`, { sms: true });
  if (t.steps.length === 1) await completeApplication(db, app!.id, actor);
  return { id: app!.id, ref };
}

async function loadForUpdate(db: Queryable, appId: string) {
  const a = await one<any>(
    db,
    `SELECT a.*, c.first_name, c.last_name FROM applications a JOIN citizens c ON c.id = a.citizen_id WHERE a.id = $1 FOR UPDATE OF a`,
    [appId],
  );
  if (!a) throw notFound('Application not found');
  return a;
}

async function completeApplication(db: Queryable, appId: string, actor: string) {
  const a = await loadForUpdate(db, appId);
  const t = await getTemplate(db, a.template_code);
  const last = t.steps.length - 1;
  await db.query(`UPDATE applications SET step = $2, status = 'completed', updated_at = now() WHERE id = $1`, [appId, last]);
  if (t.output) {
    const data = { ...a.data, name: `${a.first_name} ${a.last_name}` };
    const validTo = t.output.validYears
      ? new Date(Date.now() + t.output.validYears * 365.25 * 86400_000)
      : t.output.validDays
        ? new Date(Date.now() + t.output.validDays * 86400_000)
        : null;
    await issueDocument(db, a.citizen_id, {
      type: t.output.type,
      title: fill(t.output.title, data),
      issuerId: t.output.issuer,
      ref: a.ref,
      validTo,
      data: { applicationRef: a.ref, ...a.data },
    }, actor, { notify: false });
  }
  await notify(db, a.citizen_id, `${t.name}: complete`, t.output ? `${t.steps[last].label}. Reference ${a.ref}.` : `Reference ${a.ref}.`, { sms: true });
}

/** Move an application one step forward. Only officers of the owning agency (or admins). */
export async function advanceApplication(db: Queryable, appId: string, officer: { id: string; agency: string; role: string }, note?: string) {
  const a = await loadForUpdate(db, appId);
  const t = await getTemplate(db, a.template_code);
  if (officer.role !== 'admin' && officer.agency !== t.agency) throw forbidden(`Only ${t.agency} can process this application`);
  if (a.status !== 'open') throw conflict('not_open', 'This application is already closed');
  const next = a.step + 1;
  const actor = `officer:${officer.id}`;
  await db.query('INSERT INTO application_events (application_id, step, actor, note) VALUES ($1,$2,$3,$4)', [appId, next, actor, note ?? t.steps[next].label]);
  if (next >= t.steps.length - 1) {
    await completeApplication(db, appId, actor);
  } else {
    await db.query('UPDATE applications SET step = $2, updated_at = now() WHERE id = $1', [appId, next]);
    await notify(db, a.citizen_id, `${t.name}: ${t.steps[next].label}`, `Reference ${a.ref}.`, { sms: false });
  }
  await audit(db, actor, 'application.advanced', `application:${appId}`, { to: next });
}

/** Reject an application and refund its fee to the wallet. */
export async function rejectApplication(db: Queryable, appId: string, officer: { id: string; agency: string; role: string }, reason: string) {
  if (!reason || reason.trim().length < 5) throw badRequest('reason_required', 'Give the citizen a clear reason (at least 5 characters)');
  const a = await loadForUpdate(db, appId);
  const t = await getTemplate(db, a.template_code);
  if (officer.role !== 'admin' && officer.agency !== t.agency) throw forbidden(`Only ${t.agency} can process this application`);
  if (a.status !== 'open') throw conflict('not_open', 'This application is already closed');
  const actor = `officer:${officer.id}`;
  await db.query(`UPDATE applications SET status = 'rejected', updated_at = now() WHERE id = $1`, [appId]);
  await db.query('INSERT INTO application_events (application_id, step, actor, note) VALUES ($1,$2,$3,$4)', [appId, a.step, actor, `Rejected: ${reason}`]);
  if (t.fee > 0) {
    await post(db, {
      kind: 'gov_fee_refund',
      description: `Refund · ${t.name} · ${a.ref}`,
      idempotencyKey: `refund:${appId}`,
      meta: { applicationId: appId },
      lines: [
        { account: agencyAccount(t.agency), amount: t.fee },
        { account: walletCode(a.citizen_id), amount: -t.fee },
      ],
    });
  }
  await audit(db, actor, 'application.rejected', `application:${appId}`, { reason });
  await notify(db, a.citizen_id, `${t.name}: not approved`, `${reason}${t.fee ? ` Your fee of ${fmt(t.fee)} was refunded.` : ''}`, { sms: true });
}

export async function listApplications(db: Queryable, where: { citizenId?: string; agency?: string; status?: string }) {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (where.citizenId) conds.push(`a.citizen_id = $${params.push(where.citizenId)}`);
  if (where.agency) conds.push(`t.agency = $${params.push(where.agency)}`);
  if (where.status) conds.push(`a.status = $${params.push(where.status)}`);
  const rows = await many<any>(
    db,
    `SELECT a.id, a.ref, a.step, a.status, a.data, a.created_at, a.updated_at, t.code, t.name, t.agency, t.steps, t.fee,
            c.first_name, c.last_name, c.omang_last4
       FROM applications a JOIN service_templates t ON t.code = a.template_code JOIN citizens c ON c.id = a.citizen_id
      ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
      ORDER BY a.created_at DESC LIMIT 200`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    ref: r.ref,
    service: r.code,
    title: r.name,
    agency: r.agency,
    step: r.step,
    steps: r.steps,
    status: r.status,
    fee: r.fee,
    data: r.data,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    citizen: { name: `${r.first_name} ${r.last_name}`, omangLast4: r.omang_last4 },
  }));
}
