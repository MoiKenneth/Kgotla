import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { tx } from './db.js';
import { citizenOf, officerOf, partnerOf } from './lib/auth.js';
import { forbidden } from './lib/errors.js';
import { deleteEntry, entrySchema, listDirectory, saveEntry } from './modules/directory.js';
import {
  cancelTrip,
  gateCheckIn,
  gatePermits,
  KINDS,
  listParks,
  parkSchema,
  updatePark,
  listingDetail,
  listingSchema,
  listListings,
  myTrips,
  parksAgency,
  partnerListings,
  partnerTourismBookings,
  upsertListing,
} from './modules/tourism.js';

/**
 * Tourism (browse, trips, partner listings, park gates) and the services directory.
 * Booking itself goes through the book_tourism confirmable action (/v1/actions).
 */
export function registerTourismRoutes(app: FastifyInstance, pool: pg.Pool) {
  const body = <T extends z.ZodTypeAny>(s: T, v: unknown): z.infer<T> => s.parse(v ?? {});
  const param = (req: FastifyRequest, k: string) => String((req.params as any)[k]);
  const q = (req: FastifyRequest) => (req.query ?? {}) as Record<string, string | undefined>;

  // Browsing is open to everyone, so visitors can plan before they sign in. Booking needs an account.
  app.get('/v1/tourism/listings', async (req) => {
    const { kind, region, q: text, category } = q(req);
    return listListings(pool, { kind: kind && (KINDS as string[]).includes(kind) ? kind : undefined, region, q: text?.slice(0, 60), category: category?.slice(0, 20) });
  });
  app.get('/v1/tourism/listings/:id', async (req) => listingDetail(pool, param(req, 'id'), q(req).from));

  app.get('/v1/me/trips', async (req) => myTrips(pool, citizenOf(req)));
  app.post('/v1/me/trips/:id/cancel', async (req) => {
    const id = citizenOf(req);
    const b = body(z.object({ acceptNoRefund: z.boolean().default(false) }), req.body);
    return cancelTrip(pool, id, param(req, 'id'), b.acceptNoRefund);
  });

  // Hotels and tour operators
  app.get('/v1/partner/listings', async (req) => partnerListings(pool, partnerOf(req, 'api').id));
  app.put('/v1/partner/listings', async (req) => {
    const p = partnerOf(req, 'api');
    return tx(pool, (c) => upsertListing(c, p.id, body(listingSchema, req.body)));
  });
  app.get('/v1/partner/tourism-bookings', async (req) => {
    const p = partnerOf(req, 'api');
    const days = Math.min(90, Math.max(1, Number(q(req).days ?? 30) || 30));
    return partnerTourismBookings(pool, p.id, q(req).from, days);
  });

  // Park gates: the parks agency's officers (and admins) see and check in today's permits.
  const gateOfficer = (req: FastifyRequest) => {
    const o = officerOf(req);
    if (o.role !== 'admin' && o.agency !== parksAgency().code) throw forbidden(`This is for ${parksAgency().code} staff`);
    return o;
  };
  app.get('/v1/officer/park-permits', async (req) => {
    gateOfficer(req);
    return { agency: parksAgency(), ...(await gatePermits(pool, parksAgency().code, q(req).date)) };
  });
  app.post('/v1/officer/park-permits/:id/check-in', async (req) => {
    const o = gateOfficer(req);
    return tx(pool, (c) => gateCheckIn(c, parksAgency().code, param(req, 'id'), o.id));
  });

  app.get('/v1/officer/parks', async (req) => {
    gateOfficer(req);
    return listParks(pool);
  });
  app.put('/v1/officer/parks/:id', async (req) => {
    const o = gateOfficer(req);
    return tx(pool, (c) => updatePark(c, o.id, param(req, 'id'), body(parkSchema, req.body)));
  });

  // Services directory
  app.get('/v1/directory', async () => listDirectory(pool));
  const admin = (req: FastifyRequest) => {
    const o = officerOf(req, ['admin']);
    if (o.role !== 'admin') throw forbidden();
    return o;
  };
  app.post('/v1/officer/directory', async (req, reply) => {
    const o = admin(req);
    const r = await tx(pool, (c) => saveEntry(c, o.id, body(entrySchema, req.body)));
    return reply.status(201).send(r);
  });
  app.put('/v1/officer/directory/:id', async (req) => {
    const o = admin(req);
    return tx(pool, (c) => saveEntry(c, o.id, body(entrySchema, req.body), param(req, 'id')));
  });
  app.delete('/v1/officer/directory/:id', async (req) => {
    const o = admin(req);
    await tx(pool, (c) => deleteEntry(c, o.id, param(req, 'id')));
    return { ok: true };
  });
}
