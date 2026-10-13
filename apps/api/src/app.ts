import Fastify, { type FastifyInstance } from 'fastify';
import compress from '@fastify/compress';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { z } from 'zod';
import { config } from './config.js';
import { country, publicPack } from './countries/index.js';
import { many, one, tx } from './db.js';
import { verifyAuditChain } from './lib/audit.js';
import { citizenOf, createSession, officerOf, PinError, resolvePrincipal } from './lib/auth.js';
import { hashIdentifier, hashSecret, randomToken, verifySecret } from './lib/crypto.js';
import { audit } from './lib/audit.js';
import { AppError, badRequest, forbidden, notFound, unauthorized } from './lib/errors.js';
import { fmt } from './lib/money.js';
import { dateLabel } from './lib/time.js';
import { ACTION_TYPES, cancelAction, confirmAction, createAction, executeAction, getAction, MockVending, recentActions, type ActionCtx, type Vending } from './modules/actions.js';
import { completePayment, configuredGateways, decideTestPayment, methodsView, myPayments, reconcilePayments, startPayment, startSchema, testPaymentInfo, type Gateway } from './modules/payments.js';
import { assistantReply, contacts, type LlmClient } from './modules/assistant.js';
import { advanceApplication, listApplications, rejectApplication } from './modules/gov.js';
import {
  completeEnrolment,
  createDisclosure,
  enrolmentLiveness,
  login,
  MockLiveness,
  nationalId,
  MockRegistry,
  profile,
  startEnrolment,
  verifyDisclosure,
  verifyEnrolmentOtp,
  type Liveness,
  type Registry,
} from './modules/identity.js';
import { statement, trialBalance, walletBalance } from './modules/ledger.js';
import { availability, callNext, cancelAppointment, leaveQueue, locations, myAppointments, myTicket, queueBoard, queueOffices } from './modules/places.js';
import { handleUssd } from './modules/ussd.js';
import { createShareLink, issueDocument, listDocuments, openShareLink, revokeShareLink } from './modules/vault.js';
import { MockRegulator, myConsents, myPaymentRequests, type RegulatorRegistry } from './modules/partners.js';
import { registerPartnerRoutes } from './partnerRoutes.js';
import { registerTourismRoutes } from './tourismRoutes.js';
import { myTrips, parksAgency } from './modules/tourism.js';

export interface AppDeps {
  pool: pg.Pool;
  registry?: Registry;
  liveness?: Liveness;
  vending?: Vending;
  llm?: LlmClient | null;
  regulator?: RegulatorRegistry;
  /** Payment gateways (PayPal, DPO, test). Default: whatever this cell is configured for. */
  gateways?: Gateway[];
  logger?: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));

function webRoot(): string | null {
  const c = [config.webDir, join(here, '..', '..', 'web'), join(here, '..', '..', '..', 'web')].filter(Boolean).map((p) => resolve(p));
  return c.find((p) => existsSync(join(p, 'index.html'))) ?? null;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { pool } = deps;
  const registry = deps.registry ?? new MockRegistry(pool);
  const liveness = deps.liveness ?? new MockLiveness();
  const ctx: ActionCtx = { registry, vending: deps.vending ?? new MockVending() };
  const llm = deps.llm === undefined ? null : deps.llm;
  const gateways = deps.gateways ?? configuredGateways(pool);
  const runPaid = (citizenId: string, actionId: string, via: string) => executeAction(pool, ctx, citizenId, actionId, via);

  const app = Fastify({
    logger: deps.logger ? { level: 'info', redact: ['req.headers.authorization', 'req.headers["x-issuer-key"]'] } : false,
    bodyLimit: 4 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'", 'blob:'],
        frameAncestors: ["'none'"],
        // Pilots run behind HTTPS; local and LAN testing over plain HTTP must not be upgraded.
        upgradeInsecureRequests: config.production || config.cloud ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  // Compress everything over 1 KB: most citizens are on slow or metered mobile data.
  await app.register(compress, { global: true, threshold: 1024, encodings: ['br', 'gzip'] });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(formbody);

  app.decorateRequest('principal', null);
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/v1/')) (req as any).principal = await resolvePrincipal(pool, req);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof PinError) return reply.status(401).send({ error: { code: 'wrong_pin', message: err.message } });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: { code: 'invalid_input', message: 'Some details are missing or wrong', details: err.flatten() } });
    if (err.code === '22P02') return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
    if (err.statusCode === 429) return reply.status(429).send({ error: { code: 'rate_limited', message: 'Too many requests. Wait a minute and try again.' } });
    if (err.validation || err.statusCode === 400) return reply.status(400).send({ error: { code: 'bad_request', message: err.message } });
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong on our side. Try again.' } });
  });

  const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  // National ID in request bodies: "nationalId" (Phase 2) or "omang" (Phase 1 clients).
  const idBody = z.object({ nationalId: z.string().optional(), omang: z.string().optional() });
  const idOf = (b: { nationalId?: string; omang?: string }) => {
    const v = b.nationalId ?? b.omang;
    if (!v) throw badRequest('national_id_required', `Enter your ${country().nationalId.name}`);
    return v;
  };
  const body = <T extends z.ZodTypeAny>(s: T, v: unknown): z.infer<T> => s.parse(v ?? {});

  // -------------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------------
  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  app.get('/v1/config', async () => ({
    country: country().code,
    currency: country().currency.code,
    pack: publicPack(config.demoMode, process.env.DEMO_OFFICER_PASSWORD ? null : 'kgotla-demo'),
    demoMode: config.demoMode,
    assistant: llm ? 'claude' : 'rules',
    actions: ACTION_TYPES,
    tourism: { parksAgency: parksAgency() },
    paymentMethods: methodsView(gateways),
    enrolment: config.registryMode === 'open' ? 'open' : 'registry',
  }));

  // -------------------------------------------------------------------------
  // Payments in: PayPal, DPO Pay (cards, mobile money), test (demo only)
  // -------------------------------------------------------------------------
  app.get('/v1/payments/methods', async () => methodsView(gateways));
  app.post('/v1/me/payments', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => startPayment(pool, gateways, citizenOf(req), body(startSchema, req.body)));
  app.post('/v1/me/payments/:id/complete', async (req) => completePayment(pool, gateways, runPaid, (req.params as any).id, citizenOf(req)));
  app.get('/v1/me/payments', async (req) => myPayments(pool, citizenOf(req)));
  app.get('/v1/payments/test/:id', async (req) => testPaymentInfo(pool, (req.params as any).id));
  app.post('/v1/payments/test/:id/decide', async (req) => decideTestPayment(pool, (req.params as any).id, !!body(z.object({ approve: z.boolean() }), req.body).approve));
  app.decorate('reconcilePayments', () => reconcilePayments(pool, gateways, runPaid));

  app.post('/v1/enrol/start', strict, async (req) => {
    const b = body(
      idBody.extend({ firstName: z.string().max(60).optional(), lastName: z.string().max(60).optional(), dob: z.string().max(10).optional(), phone: z.string().max(20).optional(), district: z.string().max(60).optional() }),
      req.body,
    );
    const declared = b.firstName || b.phone ? { firstName: b.firstName ?? '', lastName: b.lastName ?? '', dob: b.dob ?? '', phone: b.phone ?? '', district: b.district ?? '' } : undefined;
    return startEnrolment(pool, registry, idOf(b), declared);
  });
  app.post('/v1/enrol/:id/otp', strict, async (req) => {
    const b = body(z.object({ code: z.string() }), req.body);
    return verifyEnrolmentOtp(pool, (req.params as any).id, b.code);
  });
  app.post('/v1/enrol/:id/liveness', strict, async (req) => {
    const b = body(z.object({ selfie: z.string().min(10) }), req.body);
    return enrolmentLiveness(pool, liveness, (req.params as any).id, b.selfie);
  });
  app.post('/v1/enrol/:id/complete', strict, async (req) => {
    const b = body(z.object({ pin: z.string(), deviceLabel: z.string().max(60).optional(), lang: z.string().max(3).optional() }), req.body);
    return completeEnrolment(pool, registry, (req.params as any).id, b);
  });

  app.post('/v1/auth/login', strict, async (req) => {
    const b = body(idBody.extend({ pin: z.string(), deviceLabel: z.string().max(60).optional() }), req.body);
    return login(pool, idOf(b), b.pin, b.deviceLabel);
  });
  app.post('/v1/auth/logout', async (req) => {
    const p = (req as any).principal;
    if (p) await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [p.sessionId]);
    return { ok: true };
  });

  /** Verifiers (shops, banks, police) check a QR presentation. */
  app.post('/v1/verify', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const b = body(z.object({ code: z.string().min(10) }), req.body);
    return verifyDisclosure(pool, b.code);
  });

  /** Public page for a time-limited document share link. */
  app.get('/s/:token', async (req, reply) => {
    const d = await openShareLink(pool, (req.params as any).token);
    reply.header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex').type('text/html; charset=utf-8');
    const page = (inner: string) =>
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kgotla shared document</title><link rel="stylesheet" href="/share.css"></head><body><main>${inner}</main></body></html>`;
    if (!d) return page(`<h1>Link not available</h1><p>This link has expired or was withdrawn by its owner. Ask them to share it again.</p>`);
    return page(`<p class="eyebrow">Kgotla · verified document</p><h1>${esc(d.title)}</h1>
      <dl><dt>Holder</dt><dd>${esc(d.first_name)} ${esc(d.last_name)} (${esc(country().nationalId.short)} ***${esc(d.omang_last4)})</dd>
      <dt>Issued by</dt><dd>${esc(d.issuer)}</dd><dt>Issued</dt><dd>${esc(dateLabel(d.issued_at))}</dd>
      ${d.valid_to ? `<dt>Valid to</dt><dd>${esc(dateLabel(d.valid_to))}</dd>` : ''}${d.ref ? `<dt>Reference</dt><dd>${esc(d.ref)}</dd>` : ''}</dl>
      <p class="ok">Issued directly by ${esc(d.issuer)} into the holder's Kgotla Vault. This link expires ${esc(new Date(d.expires_at).toUTCString())}.</p>`);
  });

  /** USSD gateway callback (Africa's Talking format). */
  app.post('/v1/ussd', async (req, reply) => {
    const b = body(z.object({ sessionId: z.string(), phoneNumber: z.string(), text: z.string().optional().default('') }), req.body);
    reply.type('text/plain');
    return handleUssd(pool, ctx, b);
  });

  // -------------------------------------------------------------------------
  // Citizen
  // -------------------------------------------------------------------------
  app.get('/v1/me', async (req) => {
    const id = citizenOf(req);
    const [p, bal, docs, apps, appts, ticket, notes, txns, discl, consents, bills, trips] = await Promise.all([
      profile(pool, id),
      walletBalance(pool, id),
      listDocuments(pool, id),
      listApplications(pool, { citizenId: id }),
      myAppointments(pool, id),
      myTicket(pool, id),
      many<any>(pool, 'SELECT id, title, body, read_at, created_at FROM notifications WHERE citizen_id = $1 ORDER BY created_at DESC LIMIT 30', [id]),
      statement(pool, id, 30),
      many<any>(pool, 'SELECT id, audience, claims, created_at, verified_at FROM disclosures WHERE citizen_id = $1 ORDER BY created_at DESC LIMIT 10', [id]),
      myConsents(pool, id),
      myPaymentRequests(pool, id),
      myTrips(pool, id),
    ]);
    return {
      profile: p,
      balance: bal,
      balanceText: fmt(bal),
      documents: docs,
      applications: apps,
      appointments: appts,
      queue: ticket,
      notifications: notes,
      unread: notes.filter((n) => !n.read_at).length,
      transactions: txns,
      disclosures: discl,
      consentRequests: consents.requests,
      connected: consents.connected,
      bills,
      trips,
    };
  });

  app.patch('/v1/me', async (req) => {
    const id = citizenOf(req);
    const b = body(z.object({ lang: z.string().max(3) }), req.body);
    if (!country().languages.some((l) => l.code === b.lang)) throw badRequest('unsupported_language', `Available: ${country().languages.map((l) => l.name).join(', ')}`);
    await pool.query('UPDATE citizens SET lang = $2 WHERE id = $1', [id, b.lang]);
    return { ok: true };
  });

  app.post('/v1/me/notifications/read', async (req) => {
    const id = citizenOf(req);
    await pool.query('UPDATE notifications SET read_at = now() WHERE citizen_id = $1 AND read_at IS NULL', [id]);
    return { ok: true };
  });

  app.get('/v1/me/contacts', async (req) => contacts(pool, citizenOf(req)));
  app.get('/v1/me/actions', async (req) => recentActions(pool, citizenOf(req)));

  app.post('/v1/me/documents/:id/share', async (req) => {
    const id = citizenOf(req);
    const b = body(z.object({ hours: z.number().int().default(24) }), req.body);
    const s = await tx(pool, (c) => createShareLink(c, id, (req.params as any).id, b.hours));
    return { id: s.id, url: `${config.publicBaseUrl}/s/${s.token}`, expiresAt: s.expiresAt };
  });
  app.delete('/v1/me/shares/:id', async (req) => {
    const id = citizenOf(req);
    await tx(pool, (c) => revokeShareLink(c, id, (req.params as any).id));
    return { ok: true };
  });

  app.post('/v1/me/disclosures', async (req) => {
    const id = citizenOf(req);
    const b = body(z.object({ claims: z.array(z.string()).min(1), audience: z.string().max(80).optional() }), req.body);
    return tx(pool, (c) => createDisclosure(c, id, b.claims, b.audience));
  });

  app.get('/v1/locations', async (req) => {
    citizenOf(req);
    return locations(pool, (req.query as any).kind);
  });
  app.get('/v1/locations/:id/availability', async (req) => {
    citizenOf(req);
    return availability(pool, (req.params as any).id, 5);
  });
  app.post('/v1/me/appointments/:id/cancel', async (req) => {
    const id = citizenOf(req);
    await tx(pool, (c) => cancelAppointment(c, id, (req.params as any).id));
    return { ok: true };
  });

  app.get('/v1/queue/offices', async (req) => {
    citizenOf(req);
    return queueOffices(pool);
  });
  app.post('/v1/me/queue/leave', async (req) => {
    await leaveQueue(pool, citizenOf(req));
    return { ok: true };
  });

  // Confirmable actions: prepare -> read back -> confirm (PIN) -> execute once.
  app.post('/v1/actions', async (req) => {
    const id = citizenOf(req);
    const b = body(z.object({ type: z.string(), params: z.record(z.any()).default({}) }), req.body);
    return tx(pool, (c) => createAction(c, ctx, id, b.type, b.params, 'app'));
  });
  app.get('/v1/actions/:id', async (req) => getAction(pool, citizenOf(req), (req.params as any).id));
  app.post('/v1/actions/:id/confirm', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const id = citizenOf(req);
    const b = body(z.object({ pin: z.string().optional() }), req.body);
    return confirmAction(pool, ctx, id, (req.params as any).id, b.pin);
  });
  app.post('/v1/actions/:id/cancel', async (req) => cancelAction(pool, citizenOf(req), (req.params as any).id));

  app.post('/v1/assistant', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const id = citizenOf(req);
    const b = body(
      z.object({ messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) })).min(1).max(40), lang: z.string().max(3).default('en') }),
      req.body,
    );
    return assistantReply(pool, ctx, llm, id, b.messages, b.lang);
  });

  // -------------------------------------------------------------------------
  // Issuers: institutions issue documents straight into a citizen's Vault.
  // -------------------------------------------------------------------------
  app.post('/v1/issuer/documents', strict, async (req) => {
    const issuerId = String(req.headers['x-issuer-id'] ?? '');
    const key = String(req.headers['x-issuer-key'] ?? '');
    const iss = await one<any>(pool, 'SELECT id, api_key_hash FROM issuers WHERE id = $1', [issuerId]);
    if (!iss || !key || !(await verifySecret(key, iss.api_key_hash))) throw unauthorized('Unknown issuer or key');
    const b = body(
      idBody.extend({ type: z.string().min(2).max(40), title: z.string().min(2).max(120), ref: z.string().max(60).optional(), validTo: z.string().optional(), data: z.record(z.any()).optional() }),
      req.body,
    );
    const c = await one<any>(pool, 'SELECT id FROM citizens WHERE omang_hash = $1', [hashIdentifier(nationalId(idOf(b)))]);
    if (!c) throw notFound(`No Kgotla account for that ${country().nationalId.name}`);
    const docId = await tx(pool, (db) =>
      issueDocument(db, c.id, { type: b.type, title: b.title, issuerId: iss.id, ref: b.ref, validTo: b.validTo ? new Date(b.validTo) : null, data: b.data }, `issuer:${iss.id}`),
    );
    return { documentId: docId };
  });

  // -------------------------------------------------------------------------
  // Partner hub: clinics, doctors, banks, insurers, utilities, schools, employers
  // -------------------------------------------------------------------------
  registerPartnerRoutes(app, pool, deps.regulator ?? new MockRegulator());
  // Tourism (stays, safaris, parks) and the directory of official portals.
  registerTourismRoutes(app, pool);

  // -------------------------------------------------------------------------
  // Officers (government case workers, counter staff, admins)
  // -------------------------------------------------------------------------
  app.post('/v1/officer/login', strict, async (req) => {
    const b = body(z.object({ username: z.string(), password: z.string() }), req.body);
    const o = await one<any>(pool, 'SELECT id, name, agency, role, password_hash FROM officers WHERE username = $1', [b.username]);
    if (!o || !(await verifySecret(b.password, o.password_hash))) throw unauthorized('Username or password is not correct');
    const s = await createSession(pool, 'officer', o.id, 'officer console');
    return { token: s.token, expiresAt: s.expiresAt, officer: { name: o.name, agency: o.agency, role: o.role } };
  });
  app.get('/v1/officer/me', async (req) => {
    const p = officerOf(req);
    const o = await one<any>(pool, 'SELECT name, agency, role FROM officers WHERE id = $1', [p.id]);
    return o;
  });
  app.get('/v1/officer/applications', async (req) => {
    const p = officerOf(req, ['caseworker']);
    const status = ((req.query as any).status as string) || 'open';
    return listApplications(pool, { agency: p.role === 'admin' ? undefined : p.agency, status });
  });
  app.post('/v1/officer/applications/:id/advance', async (req) => {
    const p = officerOf(req, ['caseworker']);
    const b = body(z.object({ note: z.string().max(300).optional() }), req.body);
    await tx(pool, (c) => advanceApplication(c, (req.params as any).id, p, b.note));
    return { ok: true };
  });
  app.post('/v1/officer/applications/:id/reject', async (req) => {
    const p = officerOf(req, ['caseworker']);
    const b = body(z.object({ reason: z.string().max(300) }), req.body);
    await tx(pool, (c) => rejectApplication(c, (req.params as any).id, p, b.reason));
    return { ok: true };
  });
  app.get('/v1/officer/offices', async (req) => {
    officerOf(req, ['counter']);
    return queueOffices(pool);
  });
  app.get('/v1/officer/queue/:locationId', async (req) => {
    officerOf(req, ['counter']);
    return queueBoard(pool, (req.params as any).locationId);
  });
  app.post('/v1/officer/queue/:locationId/call-next', async (req) => {
    const p = officerOf(req, ['counter']);
    const b = body(z.object({ counter: z.number().int().min(1).max(50) }), req.body);
    const r = await tx(pool, (c) => callNext(c, (req.params as any).locationId, b.counter, `officer:${p.id}`));
    return r ?? { empty: true };
  });
  // Staff accounts (admins only). The password is shown once; the officer gets it in person.
  app.get('/v1/officer/officers', async (req) => {
    const p = officerOf(req, ['admin']);
    if (p.role !== 'admin') throw forbidden();
    return many<any>(pool, 'SELECT id, username, name, agency, role, created_at FROM officers ORDER BY agency, username');
  });
  app.post('/v1/officer/officers', async (req, reply) => {
    const p = officerOf(req, ['admin']);
    if (p.role !== 'admin') throw forbidden();
    const b = body(z.object({ username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/, 'Usernames use 3 to 40 lowercase letters, digits, dots or dashes'), name: z.string().trim().min(2).max(80), agency: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,12}$/), role: z.enum(['caseworker', 'counter', 'admin']) }), req.body);
    const password = randomToken(12);
    try {
      const r = await tx(pool, async (c) => {
        const o = await one<any>(c, 'INSERT INTO officers (username, name, agency, role, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id', [b.username, b.name, b.agency, b.role, await hashSecret(password)]);
        await audit(c, `officer:${p.id}`, 'officer.created', `officer:${o.id}`, { username: b.username, agency: b.agency, role: b.role });
        return o;
      });
      return reply.status(201).send({ id: r.id, username: b.username, password });
    } catch (e: any) {
      if (e?.code === '23505') throw new AppError(409, 'taken', 'That username is taken');
      throw e;
    }
  });

  app.get('/v1/officer/overview', async (req) => {
    const p = officerOf(req, ['admin']);
    if (p.role !== 'admin') throw forbidden();
    const counts = await one<any>(
      pool,
      `SELECT (SELECT count(*)::int FROM citizens) AS citizens,
              (SELECT count(*)::int FROM applications WHERE status = 'open') AS open_applications,
              (SELECT count(*)::int FROM applications WHERE status = 'completed') AS completed_applications,
              (SELECT count(*)::int FROM pending_actions WHERE status = 'done') AS actions_done,
              (SELECT count(*)::int FROM pending_actions WHERE status = 'done' AND source = 'assistant') AS assistant_actions,
              (SELECT count(*)::int FROM queue_tickets WHERE day = CURRENT_DATE) AS tickets_today,
              (SELECT count(*)::int FROM outbox WHERE processed_at IS NULL) AS outbox_pending,
              (SELECT count(*)::int FROM partners WHERE status = 'applied') AS partners_waiting,
              (SELECT count(*)::int FROM partners WHERE status = 'approved') AS partners_live,
              (SELECT count(*)::int FROM webhook_deliveries WHERE status = 'failed') AS webhooks_failed,
              (SELECT count(*)::int FROM tourism_bookings WHERE status <> 'cancelled') AS tourism_bookings,
              (SELECT count(*)::int FROM directory_entries) AS directory_entries`,
    );
    const tb = await trialBalance(pool);
    const brokenAt = await verifyAuditChain(pool);
    return { ...counts, ledgerBalanced: tb === 0, auditChainIntact: brokenAt === null, auditBrokenAt: brokenAt };
  });

  // -------------------------------------------------------------------------
  // Web apps (citizen PWA, officer console, verifier)
  // -------------------------------------------------------------------------
  // QR library served from the installed package (MIT, qrcode-generator) instead of a vendored copy.
  const qrPath = createRequire(import.meta.url).resolve('qrcode-generator/qrcode.js');
  const qrSource = readFileSync(qrPath, 'utf8');
  app.get('/vendor/qrcode.js', async (_req, reply) => reply.type('application/javascript; charset=utf-8').header('Cache-Control', 'public, max-age=86400').send(qrSource));

  const root = webRoot();
  if (root) {
    await app.register(fastifyStatic, {
      root,
      prefix: '/',
      setHeaders(res, path) {
        if (path.endsWith('sw.js')) res.setHeader('Service-Worker-Allowed', '/');
        if (path.endsWith('.html') || path.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/v1/')) return reply.status(404).send({ error: { code: 'not_found', message: 'Unknown endpoint' } });
    if (root && req.method === 'GET') return reply.sendFile('index.html');
    return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  void badRequest;
  return app;
}
