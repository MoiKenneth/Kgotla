import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { config } from './config.js';
import { PARTNER_TYPE_INFO } from './countries/partners.js';
import { one, tx } from './db.js';
import { citizenOf, officerOf, partnerOf } from './lib/auth.js';
import { forbidden, notFound } from './lib/errors.js';
import { verifySignature, webhookSecret } from './lib/webhooks.js';
import {
  applyPartner,
  applySchema,
  approvePartner,
  cancelPaymentRequest,
  catalogue,
  consentRequestSchema,
  createCredential,
  createPaymentRequest,
  decideConsent,
  declinePaymentRequest,
  getConsentForPartner,
  getPaymentRequest,
  issueToken,
  listPartners,
  locationSchema,
  markAttended,
  myConsents,
  myPaymentRequests,
  notifySchema,
  partnerAppointments,
  partnerDocSchema,
  partnerDocuments,
  partnerIdentity,
  partnerIssueDocument,
  partnerLocations,
  partnerNotify,
  paymentRequestSchema,
  portalLogin,
  portalView,
  requestConsent,
  revealWebhookSecret,
  revokeConsent,
  revokeCredential,
  sendTestEvent,
  setPartnerStatus,
  setWebhook,
  upsertLocation,
  type RegulatorRegistry,
} from './modules/partners.js';

/**
 * Routes for the partner hub.
 *
 *   /v1/partners/*        public: catalogue, applications
 *   /v1/partner-portal/*  partner staff in the portal (email + password session)
 *   /v1/oauth/token       OAuth 2.0 client credentials for partner systems
 *   /v1/partner/*         partner systems (Bearer access token + citizen consent)
 *   /v1/me/consents, /v1/me/payment-requests   citizens
 *   /v1/officer/partners  Kgotla admins review and approve
 */
export function registerPartnerRoutes(app: FastifyInstance, pool: pg.Pool, regulator: RegulatorRegistry) {
  const body = <T extends z.ZodTypeAny>(s: T, v: unknown): z.infer<T> => s.parse(v ?? {});
  const param = (req: FastifyRequest, k: string) => String((req.params as any)[k]);
  const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  // ---------------------------------------------------------------- public
  app.get('/v1/partners/catalogue', async () => catalogue());
  app.post('/v1/partners/apply', strict, async (req, reply) => {
    const r = await applyPartner(pool, regulator, body(applySchema, req.body));
    return reply.status(201).send(r);
  });

  // ---------------------------------------------------------------- portal
  app.post('/v1/partner-portal/login', strict, async (req) => {
    const b = body(z.object({ email: z.string(), password: z.string() }), req.body);
    return portalLogin(pool, b.email, b.password);
  });
  app.post('/v1/partner-portal/logout', async (req) => {
    const p = partnerOf(req, 'portal');
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [p.sessionId]);
    return { ok: true };
  });
  app.get('/v1/partner-portal/me', async (req) => portalView(pool, partnerOf(req, 'portal').id));
  app.post('/v1/partner-portal/credentials', async (req) => {
    const p = partnerOf(req, 'portal');
    const b = body(z.object({ label: z.string().max(60).default('API key') }), req.body);
    return tx(pool, (c) => createCredential(c, p.id, b.label));
  });
  app.delete('/v1/partner-portal/credentials/:id', async (req) => {
    const p = partnerOf(req, 'portal');
    await tx(pool, (c) => revokeCredential(c, p.id, param(req, 'id')));
    return { ok: true };
  });
  app.put('/v1/partner-portal/webhook', async (req) => {
    const p = partnerOf(req, 'portal');
    const b = body(z.object({ url: z.string().max(300).nullable() }), req.body);
    return tx(pool, (c) => setWebhook(c, p.id, b.url || null));
  });
  app.post('/v1/partner-portal/webhook/secret', async (req) => {
    const p = partnerOf(req, 'portal');
    const b = body(z.object({ rotate: z.boolean().default(false) }), req.body);
    return tx(pool, (c) => revealWebhookSecret(c, p.id, b.rotate));
  });
  app.post('/v1/partner-portal/webhook/test', async (req) => {
    const p = partnerOf(req, 'portal');
    return tx(pool, (c) => sendTestEvent(c, p.id));
  });

  // ---------------------------------------------------------------- OAuth
  // Accepts JSON or form bodies, and HTTP Basic client authentication (RFC 6749 §2.3.1).
  app.post('/v1/oauth/token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    let clientId = b.client_id;
    let clientSecret = b.client_secret;
    const h = req.headers.authorization;
    if (h?.startsWith('Basic ')) {
      const [id, ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
      clientId = decodeURIComponent(id);
      clientSecret = decodeURIComponent(rest.join(':'));
    }
    if ((b.grant_type ?? 'client_credentials') !== 'client_credentials') {
      return reply.status(400).send({ error: 'unsupported_grant_type', error_description: 'Use grant_type=client_credentials' });
    }
    if (!clientId || !clientSecret) return reply.status(400).send({ error: 'invalid_request', error_description: 'Send client_id and client_secret' });
    const t = await issueToken(pool, clientId, clientSecret);
    if (!t) return reply.status(401).send({ error: 'invalid_client', error_description: 'Unknown client, wrong secret, revoked key, or partner not approved' });
    return reply.header('Cache-Control', 'no-store').send(t);
  });

  // ---------------------------------------------------------------- partner API
  app.get('/v1/partner/me', async (req) => {
    const p = partnerOf(req, 'api');
    const v = await portalView(pool, p.id);
    return { partner: v.partner, locations: v.locations };
  });
  app.post('/v1/partner/consents', async (req, reply) => {
    const p = partnerOf(req, 'api');
    const r = await tx(pool, (c) => requestConsent(c, p.id, body(consentRequestSchema, req.body)));
    return reply.status(r.status === 'granted' ? 200 : 201).send(r);
  });
  app.get('/v1/partner/consents/:id', async (req) => getConsentForPartner(pool, partnerOf(req, 'api').id, param(req, 'id')));

  app.get('/v1/partner/citizens/:subject/identity', async (req) => {
    const p = partnerOf(req, 'api');
    return tx(pool, (c) => partnerIdentity(c, p.id, param(req, 'subject')));
  });
  app.get('/v1/partner/citizens/:subject/documents', async (req) => {
    const p = partnerOf(req, 'api');
    return tx(pool, (c) => partnerDocuments(c, p.id, param(req, 'subject')));
  });
  app.post('/v1/partner/citizens/:subject/documents', async (req, reply) => {
    const p = partnerOf(req, 'api');
    const r = await tx(pool, (c) => partnerIssueDocument(c, p.id, param(req, 'subject'), body(partnerDocSchema, req.body)));
    return reply.status(201).send(r);
  });
  app.post('/v1/partner/citizens/:subject/notifications', async (req) => {
    const p = partnerOf(req, 'api');
    return tx(pool, (c) => partnerNotify(c, p.id, param(req, 'subject'), body(notifySchema, req.body)));
  });
  app.post('/v1/partner/citizens/:subject/payment-requests', async (req, reply) => {
    const p = partnerOf(req, 'api');
    const r = await tx(pool, (c) => createPaymentRequest(c, p.id, param(req, 'subject'), body(paymentRequestSchema, req.body)));
    return reply.status(201).send(r);
  });
  app.get('/v1/partner/payment-requests/:id', async (req) => getPaymentRequest(pool, partnerOf(req, 'api').id, param(req, 'id')));
  app.post('/v1/partner/payment-requests/:id/cancel', async (req) => {
    const p = partnerOf(req, 'api');
    return tx(pool, (c) => cancelPaymentRequest(c, p.id, param(req, 'id')));
  });

  app.get('/v1/partner/locations', async (req) => partnerLocations(pool, partnerOf(req, 'api').id));
  app.put('/v1/partner/locations', async (req) => {
    const p = partnerOf(req, 'api');
    return tx(pool, (c) => upsertLocation(c, p.id, body(locationSchema, req.body)));
  });
  app.get('/v1/partner/appointments', async (req) => {
    const p = partnerOf(req, 'api');
    const q = req.query as { from?: string; days?: string };
    const days = Math.min(31, Math.max(1, Number(q.days ?? 14) || 14));
    return partnerAppointments(pool, p.id, q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : undefined, days);
  });
  app.post('/v1/partner/appointments/:id/attended', async (req) => {
    const p = partnerOf(req, 'api');
    return tx(pool, (c) => markAttended(c, p.id, param(req, 'id')));
  });

  // ---------------------------------------------------------------- citizens
  app.get('/v1/me/consents', async (req) => myConsents(pool, citizenOf(req)));
  app.post('/v1/me/consents/:id/approve', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const id = citizenOf(req);
    const b = body(z.object({ pin: z.string().optional() }), req.body);
    return decideConsent(pool, id, param(req, 'id'), 'grant', b.pin);
  });
  app.post('/v1/me/consents/:id/decline', async (req) => decideConsent(pool, citizenOf(req), param(req, 'id'), 'decline'));
  app.post('/v1/me/consents/:id/revoke', async (req) => revokeConsent(pool, citizenOf(req), param(req, 'id')));
  app.get('/v1/me/payment-requests', async (req) => myPaymentRequests(pool, citizenOf(req)));
  app.post('/v1/me/payment-requests/:id/decline', async (req) => declinePaymentRequest(pool, citizenOf(req), param(req, 'id')));

  // ---------------------------------------------------------------- Kgotla admins
  app.get('/v1/officer/partners', async (req) => {
    const o = officerOf(req, ['admin']);
    if (o.role !== 'admin') throw forbidden();
    const status = (req.query as any).status as string | undefined;
    return { partners: await listPartners(pool, status && ['applied', 'approved', 'rejected', 'suspended'].includes(status) ? status : undefined), types: PARTNER_TYPE_INFO };
  });
  app.post('/v1/officer/partners/:id/approve', async (req) => {
    const o = officerOf(req, ['admin']);
    if (o.role !== 'admin') throw forbidden();
    const b = body(z.object({ capabilities: z.array(z.string()).optional(), note: z.string().max(300).optional() }), req.body);
    await tx(pool, (c) => approvePartner(c, param(req, 'id'), o.id, b));
    return { ok: true };
  });
  for (const [path, status] of [['reject', 'rejected'], ['suspend', 'suspended'], ['reinstate', 'approved']] as const) {
    app.post(`/v1/officer/partners/:id/${path}`, async (req) => {
      const o = officerOf(req, ['admin']);
      if (o.role !== 'admin') throw forbidden();
      const b = body(z.object({ note: z.string().min(path === 'reinstate' ? 0 : 3).max(300).default('') }), req.body);
      await tx(pool, (c) => setPartnerStatus(c, param(req, 'id'), o.id, status, b.note));
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------- demo webhook receiver
  // Demo cells only: stands in for a partner's server so the portal can show deliveries arriving and their signatures checking out.
  app.post('/v1/demo/webhook-inbox/:code', async (req) => {
    if (!config.demoMode) throw notFound('Unknown endpoint');
    const p = await one<any>(pool, 'SELECT id, webhook_secret_version FROM partners WHERE code = $1', [param(req, 'code')]);
    if (!p) throw notFound('Unknown partner');
    const raw = JSON.stringify(req.body ?? {});
    const ok = verifySignature(webhookSecret(p.id, p.webhook_secret_version), String(req.headers['kgotla-signature'] ?? ''), raw);
    await pool.query('INSERT INTO demo_webhook_inbox (partner_code, event, signature_ok, body) VALUES ($1,$2,$3,$4)', [param(req, 'code'), String(req.headers['kgotla-event'] ?? ''), ok, raw]);
    return { received: true, signatureOk: ok };
  });
}
