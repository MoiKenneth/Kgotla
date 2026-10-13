import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localDate } from '../src/lib/time.js';
import { processWebhooks, type FetchLike } from '../src/lib/webhooks.js';
import { balance, call, harness, login, MPHO, NALEDI, officerLogin, type Harness } from './helpers.js';

const plus = (n: number) => new Date(Date.parse(localDate() + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10);

async function book(h: Harness, token: string, params: Record<string, unknown>, pin: string) {
  const a = await call(h.app, token, 'POST', '/v1/actions', { type: 'book_tourism', params });
  if (a.status !== 200) return a;
  return call(h.app, token, 'POST', `/v1/actions/${a.json.id}/confirm`, { pin });
}

/** Top up a demo wallet in limit-sized steps. */
async function topUp(h: Harness, token: string, pin: string, times: number) {
  for (let i = 0; i < times; i++) {
    const a = await call(h.app, token, 'POST', '/v1/actions', { type: 'top_up', params: { source: 'orange_money', amount: '10000' } });
    await call(h.app, token, 'POST', `/v1/actions/${a.json.id}/confirm`, { pin });
  }
}

describe('tourism', () => {
  let h: Harness;
  let naledi: string;
  beforeAll(async () => {
    h = await harness();
    naledi = await login(h.app, NALEDI);
  });
  afterAll(async () => h?.close());

  it('lists parks, stays and safaris without signing in', async () => {
    const all = await call(h.app, null, 'GET', '/v1/tourism/listings');
    const kinds = new Set(all.json.listings.map((l: any) => l.kind));
    expect(kinds).toEqual(new Set(['park', 'reserve', 'stay', 'safari', 'driver']));
    const chobe = all.json.listings.find((l: any) => l.id === 'park-chobe');
    expect(chobe.provider).toBe('Department of Wildlife and National Parks');
    expect(chobe.fromText).toBe('P 10.00');
    const parks = await call(h.app, null, 'GET', '/v1/tourism/listings?kind=park');
    expect(parks.json.listings.every((l: any) => l.kind === 'park')).toBe(true);
    const search = await call(h.app, null, 'GET', '/v1/tourism/listings?q=mokoro');
    expect(search.json.listings.map((l: any) => l.id)).toContain('tsodilo-trails-mokoro-day');
    const detail = await call(h.app, null, 'GET', '/v1/tourism/listings/park-moremi');
    expect(detail.json.availability).toHaveLength(14);
    expect(detail.json.availability[0].left).toBe(150);
  });

  it('books a park permit at the citizen rate, paid with PIN, permit in the Vault', async () => {
    const before = await balance(h.app, naledi);
    const a = await call(h.app, naledi, 'POST', '/v1/actions', { type: 'book_tourism', params: { listingId: 'park-chobe', rateKey: 'citizen', startDate: plus(10), days: 2, quantity: 3 } });
    expect(a.status).toBe(200);
    expect(a.json.amountText).toBe('P 60.00'); // 3 people x 2 days x P10
    expect(a.json.readback.find((r: string[]) => r[0] === 'Paid to')[1]).toBe('Department of Wildlife and National Parks');
    expect((await call(h.app, naledi, 'POST', `/v1/actions/${a.json.id}/confirm`, {})).json.error.code).toBe('pin_required');
    const done = await call(h.app, naledi, 'POST', `/v1/actions/${a.json.id}/confirm`, { pin: NALEDI.pin });
    expect(done.json.status).toBe('done');
    expect(done.json.result.ref).toMatch(/^PP-/);
    expect(await balance(h.app, naledi)).toBe(before - 6000);
    const me = await call(h.app, naledi, 'GET', '/v1/me');
    const permit = me.json.documents.find((d: any) => d.type === 'park_permit');
    expect(permit.title).toContain('Chobe National Park');
    expect(permit.issuer).toBe('Department of Wildlife and National Parks');
    expect(me.json.trips[0]).toMatchObject({ ref: done.json.result.ref, quantity: 3, status: 'confirmed', refundIfCancelled: 6000 });
  });

  it('never sells more than the capacity, even across overlapping stays', async () => {
    // The demo lodge's Gaborone guesthouse has 10 rooms.
    const id = 'letsatsi-lodge-gaborone';
    await topUp(h, naledi, NALEDI.pin, 3);
    const r1 = await book(h, naledi, { listingId: id, rateKey: 'standard', startDate: plus(20), days: 3, quantity: 7 }, NALEDI.pin);
    expect(r1.json.status).toBe('done');
    const mpho = await login(h.app, MPHO);
    await topUp(h, mpho, MPHO.pin, 1);
    // Overlaps night 3 only: 3 rooms left that night, so 4 is refused, 3 is fine.
    const tooMany = await call(h.app, mpho, 'POST', '/v1/actions', { type: 'book_tourism', params: { listingId: id, rateKey: 'standard', startDate: plus(22), days: 2, quantity: 4 } });
    expect(tooMany.json.error.code).toBe('sold_out');
    const ok = await book(h, mpho, { listingId: id, rateKey: 'standard', startDate: plus(22), days: 2, quantity: 3 }, MPHO.pin);
    expect(ok.json.status).toBe('done');
    const detail = await call(h.app, null, 'GET', `/v1/tourism/listings/${id}?from=${plus(20)}`);
    expect(detail.json.availability.slice(0, 4).map((d: any) => d.left)).toEqual([3, 3, 0, 7]);
  });

  it('a safari has a fixed length and is priced per person', async () => {
    const a = await call(h.app, naledi, 'POST', '/v1/actions', { type: 'book_tourism', params: { listingId: 'tsodilo-trails-chobe-3day', rateKey: 'child', startDate: plus(30), days: 9, quantity: 2 } });
    expect(a.json.amountText).toBe('P 6,800.00'); // 2 children x P3,400, 3 days regardless of "days"
    expect(a.json.readback.find((r: string[]) => r[0] === 'When')[1]).toContain('3 days');
    await call(h.app, naledi, 'POST', `/v1/actions/${a.json.id}/cancel`);
  });

  it('lodges, game reserves and drivers: categories and per-vehicle pricing', async () => {
    const lodges = await call(h.app, null, 'GET', '/v1/tourism/listings?kind=stay&category=lodge');
    expect(lodges.json.listings.map((l: any) => l.id)).toEqual(['letsatsi-lodge-river-rooms']);
    const guesthouses = await call(h.app, null, 'GET', '/v1/tourism/listings?kind=stay&category=guesthouse');
    expect(guesthouses.json.listings.map((l: any) => l.category)).toEqual(['guesthouse']);
    const reserves = await call(h.app, null, 'GET', '/v1/tourism/listings?kind=reserve');
    expect(reserves.json.listings.map((l: any) => l.provider)).toContain('Tshwene Wildlife Reserve');
    const drivers = await call(h.app, null, 'GET', '/v1/tourism/listings?kind=driver');
    expect(drivers.json.listings.map((l: any) => l.category).sort()).toEqual(['driver_guide', 'transfer']);

    // Airport transfer: per vehicle, one way, whatever "days" says.
    const t = await call(h.app, naledi, 'POST', '/v1/actions', { type: 'book_tourism', params: { listingId: 'motse-drive-airport-transfer', rateKey: 'minibus', startDate: plus(9), days: 5, quantity: 2 } });
    expect(t.json.amountText).toBe('P 1,200.00');
    expect(t.json.readback).toContainEqual(['Vehicles', '2 vehicles · Minibus (up to 10 people)']);
    // Driver-guide: per vehicle per day.
    const g = await call(h.app, naledi, 'POST', '/v1/actions', { type: 'book_tourism', params: { listingId: 'motse-drive-driver-guide', rateKey: '4x4', startDate: plus(9), days: 3, quantity: 1 } });
    expect(g.json.amountText).toBe('P 7,500.00');
    // Game drive: per person.
    const d = await call(h.app, naledi, 'POST', '/v1/actions', { type: 'book_tourism', params: { listingId: 'tshwene-reserve-game-drive', rateKey: 'adult', startDate: plus(9), quantity: 2 } });
    expect(d.json.amountText).toBe('P 700.00');
    const done = await call(h.app, naledi, 'POST', `/v1/actions/${d.json.id}/confirm`, { pin: NALEDI.pin });
    expect(done.json.result.message).toContain('Booked');
    const me = await call(h.app, naledi, 'GET', '/v1/me');
    expect(me.json.documents.find((x: any) => x.type === 'booking_voucher' && x.title.startsWith('Reserve booking'))).toBeTruthy();
    for (const a of [t, g]) await call(h.app, naledi, 'POST', `/v1/actions/${a.json.id}/cancel`);
  });

  it('a transfer company publishes trips priced per vehicle', async () => {
    const tok = (await h.app.inject({ method: 'POST', url: '/v1/oauth/token', payload: { client_id: 'demo-transport', client_secret: 'demo-transport-secret' } })).json().access_token;
    const r = await call(h.app, tok, 'PUT', '/v1/partner/listings', {
      key: 'maun-airport', name: 'Maun airport transfer', region: 'Okavango Delta · Maun', description: 'Maun airport to any lodge in town.', unit: 'trip', category: 'transfer',
      rates: [{ key: 'sedan', label: 'Sedan', price: '200' }], capacity: 3,
    });
    expect(r.json).toMatchObject({ kind: 'driver', unit: 'trip', category: 'transfer' });
    const bad = await call(h.app, tok, 'PUT', '/v1/partner/listings', { key: 'x2', name: 'Bad one', region: 'Maun', description: 'Wrong category here.', category: 'lodge', rates: [{ key: 'a', label: 'A1', price: 1 }], capacity: 1 });
    expect(bad.json.error.code).toBe('invalid_category');
  });

  it('refuses bad input before charging anything', async () => {
    const prep = (params: object) => call(h.app, naledi, 'POST', '/v1/actions', { type: 'book_tourism', params });
    expect((await prep({ listingId: 'park-chobe', rateKey: 'vip', startDate: plus(5), quantity: 1 })).json.error.code).toBe('invalid_rate');
    expect((await prep({ listingId: 'park-chobe', rateKey: 'citizen', startDate: plus(-1), quantity: 1 })).json.error.code).toBe('invalid_date');
    expect((await prep({ listingId: 'park-chobe', rateKey: 'citizen', startDate: plus(400), quantity: 1 })).json.error.code).toBe('invalid_date');
    expect((await prep({ listingId: 'nowhere', rateKey: 'citizen', startDate: plus(5), quantity: 1 })).status).toBe(404);
    // More than the wallet holds (8 family rooms for 14 nights).
    expect((await prep({ listingId: 'letsatsi-lodge-river-rooms', rateKey: 'family', startDate: plus(40), days: 14, quantity: 8 })).json.error.code).toBe('insufficient_funds');
  });

  it('cancels with a full refund before the cut-off; after it only on purpose and without refund', async () => {
    const trips = (await call(h.app, naledi, 'GET', '/v1/me/trips')).json;
    const chobe = trips.find((t: any) => t.listing.id === 'park-chobe');
    const before = await balance(h.app, naledi);
    const c = await call(h.app, naledi, 'POST', `/v1/me/trips/${chobe.id}/cancel`, {});
    expect(c.json).toMatchObject({ status: 'cancelled', refunded: 6000 });
    expect(await balance(h.app, naledi)).toBe(before + 6000);
    expect((await call(h.app, naledi, 'POST', `/v1/me/trips/${chobe.id}/cancel`, {})).status).toBe(409);
    const me = await call(h.app, naledi, 'GET', '/v1/me');
    expect(me.json.documents.some((d: any) => d.type === 'park_permit')).toBe(false); // permit withdrawn

    // Tomorrow's park entry is inside the 24-hour cut-off.
    const late = await book(h, naledi, { listingId: 'park-moremi', rateKey: 'citizen', startDate: plus(0), days: 1, quantity: 1 }, NALEDI.pin);
    expect(late.json.status).toBe('done');
    const t = (await call(h.app, naledi, 'GET', '/v1/me/trips')).json.find((x: any) => x.listing.id === 'park-moremi');
    expect(t.refundIfCancelled).toBe(0);
    expect((await call(h.app, naledi, 'POST', `/v1/me/trips/${t.id}/cancel`, {})).json.error.code).toBe('no_refund');
    const bal = await balance(h.app, naledi);
    expect((await call(h.app, naledi, 'POST', `/v1/me/trips/${t.id}/cancel`, { acceptNoRefund: true })).json.refunded).toBe(0);
    expect(await balance(h.app, naledi)).toBe(bal);
  });

  it('park gate officers see and check in today’s permits', async () => {
    const r = await book(h, naledi, { listingId: 'park-ckgr', rateKey: 'citizen', startDate: plus(0), days: 2, quantity: 2 }, NALEDI.pin);
    expect(r.json.status).toBe('done');
    const gate = await officerLogin(h.app, 'parks.gate');
    const list = await call(h.app, gate, 'GET', '/v1/officer/park-permits');
    const p = list.json.permits.find((x: any) => x.ref === r.json.result.ref);
    expect(p).toMatchObject({ holder: 'Naledi Mothibi', people: 2, idLast4: '1904', park: 'Central Kalahari Game Reserve' });
    expect((await call(h.app, gate, 'POST', `/v1/officer/park-permits/${p.id}/check-in`)).json.status).toBe('completed');
    expect((await call(h.app, gate, 'POST', `/v1/officer/park-permits/${p.id}/check-in`)).status).toBe(404);
    const drts = await officerLogin(h.app, 'drts.case');
    expect((await call(h.app, drts, 'GET', '/v1/officer/park-permits')).status).toBe(403);
  });

  it('a new lodge onboards, publishes rooms, and hears about bookings', async () => {
    const applied = await call(h.app, null, 'POST', '/v1/partners/apply', {
      type: 'hotel', legalName: 'Kasane Baobab Camp (Pty) Ltd', tradingName: 'Kasane Baobab Camp', registrationNo: 'BW00001112223', licenceNo: 'TEL-1201',
      contactName: 'Lorato Seemule', contactEmail: 'stay@baobab.example', contactPhone: '72 111 222', password: 'baobab-portal-pass', webhookUrl: 'https://baobab.example/hooks',
    });
    expect(applied.json.licenceCheck.register).toContain('Department of Tourism');
    const admin = await officerLogin(h.app, 'admin');
    await call(h.app, admin, 'POST', `/v1/officer/partners/${applied.json.partnerId}/approve`, {});
    const portal = (await call(h.app, null, 'POST', '/v1/partner-portal/login', { email: 'stay@baobab.example', password: 'baobab-portal-pass' })).json.token;
    const key = (await call(h.app, portal, 'POST', '/v1/partner-portal/credentials', {})).json;
    const tok = (await h.app.inject({ method: 'POST', url: '/v1/oauth/token', payload: { client_id: key.clientId, client_secret: key.clientSecret } })).json().access_token;

    const saved = await call(h.app, tok, 'PUT', '/v1/partner/listings', {
      key: 'tents', name: 'Kasane Baobab Camp', region: 'Chobe · Kasane', description: 'Tented camp under baobabs, five minutes from the Chobe riverfront.',
      highlights: ['River cruises', 'Pool'], rates: [{ key: 'tent', label: 'Safari tent (2 people)', price: '900.00' }], capacity: 2, cancelHours: 48,
    });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ id: expect.stringContaining('-tents'), kind: 'stay', fromText: 'P 900.00' });
    // A clinic cannot publish tourism listings.
    const clinic = (await h.app.inject({ method: 'POST', url: '/v1/oauth/token', payload: { client_id: 'demo-clinic', client_secret: 'demo-clinic-secret' } })).json().access_token;
    expect((await call(h.app, clinic, 'PUT', '/v1/partner/listings', { key: 'x1', name: 'Clinic stay', region: 'Gaborone', description: 'Not allowed for a clinic.', rates: [{ key: 'a', label: 'Room', price: 1 }], capacity: 1 })).status).toBe(403);

    const mpho = await login(h.app, MPHO);
    const r = await book(h, mpho, { listingId: saved.json.id, rateKey: 'tent', startDate: plus(15), days: 2, quantity: 1 }, MPHO.pin);
    expect(r.json.status).toBe('done');
    const bookings = await call(h.app, tok, 'GET', '/v1/partner/tourism-bookings');
    expect(bookings.json[0]).toMatchObject({ ref: r.json.result.ref, quantity: 1, totalText: 'P 1,800.00' });
    expect(bookings.json[0].guest.name).toBe('Mpho Kgosi');

    const got: string[] = [];
    const fetchImpl: FetchLike = async (_u, init) => { got.push(init.headers['kgotla-event']); return { status: 200, ok: true }; };
    await processWebhooks(h.pool, fetchImpl);
    expect(got).toContain('tourism_booking.confirmed');

    const view = await call(h.app, portal, 'GET', '/v1/partner-portal/me');
    expect(view.json.tourism.listings).toHaveLength(1);
    expect(view.json.tourism.bookings).toHaveLength(1);

    // Suspended partners' listings disappear from search.
    await call(h.app, admin, 'POST', `/v1/officer/partners/${applied.json.partnerId}/suspend`, { note: 'Licence lapsed' });
    const list = await call(h.app, null, 'GET', '/v1/tourism/listings?q=baobab');
    expect(list.json.listings).toHaveLength(0);
  });

  it('the parks agency sets real fees and opens or closes a park', async () => {
    const gate = await officerLogin(h.app, 'parks.gate');
    const parks = await call(h.app, gate, 'GET', '/v1/officer/parks');
    expect(parks.json.map((p: any) => p.id)).toContain('park-chobe');
    const u = await call(h.app, gate, 'PUT', '/v1/officer/parks/park-chobe', { active: true, capacity: 300, rates: [{ key: 'citizen', price: '12.50' }] });
    expect(u.json.rates.find((r: any) => r.key === 'citizen').price).toBe(1250);
    expect(u.json.capacity).toBe(300);
    expect((await call(h.app, gate, 'PUT', '/v1/officer/parks/park-chobe', { active: true, rates: [{ key: 'citizen', price: '0' }] })).status).toBe(400);
    await call(h.app, gate, 'PUT', '/v1/officer/parks/park-moremi', { active: false });
    const list = await call(h.app, null, 'GET', '/v1/tourism/listings?kind=park');
    expect(list.json.listings.map((l: any) => l.id)).not.toContain('park-moremi');
    await call(h.app, gate, 'PUT', '/v1/officer/parks/park-moremi', { active: true });
  });

  it('admins create staff accounts with a one-time password', async () => {
    const admin = await officerLogin(h.app, 'admin');
    const r = await call(h.app, admin, 'POST', '/v1/officer/officers', { username: 'gate.kasane', name: 'Neo Gate', agency: 'dwnp', role: 'counter' });
    expect(r.status).toBe(201);
    const login2 = await call(h.app, null, 'POST', '/v1/officer/login', { username: 'gate.kasane', password: r.json.password });
    expect(login2.json.officer).toMatchObject({ agency: 'DWNP', role: 'counter' });
    expect((await call(h.app, login2.json.token, 'GET', '/v1/officer/park-permits')).status).toBe(200);
    expect((await call(h.app, admin, 'POST', '/v1/officer/officers', { username: 'gate.kasane', name: 'Again', agency: 'DWNP', role: 'counter' })).status).toBe(409);
    expect((await call(h.app, login2.json.token, 'POST', '/v1/officer/officers', { username: 'sneaky', name: 'No', agency: 'DWNP', role: 'admin' })).status).toBe(403);
  });

  it('keeps the ledger balanced and the audit chain intact', async () => {
    const admin = await officerLogin(h.app, 'admin');
    const ov = await call(h.app, admin, 'GET', '/v1/officer/overview');
    expect(ov.json.ledgerBalanced).toBe(true);
    expect(ov.json.auditChainIntact).toBe(true);
    expect(ov.json.tourism_bookings).toBeGreaterThan(0);
  });
});

describe('services directory', () => {
  let h: Harness;
  beforeAll(async () => { h = await harness(); });
  afterAll(async () => h?.close());

  it('starts with the official Botswana portals and admins can add more', async () => {
    const d = await call(h.app, null, 'GET', '/v1/directory');
    const names = d.json.map((e: any) => e.name);
    expect(names).toEqual(expect.arrayContaining(['BURS e-Tax', 'FNB Botswana', 'Life Gaborone Private Hospital']));
    expect(d.json.find((e: any) => e.name === 'BURS e-Tax')).toMatchObject({ sector: 'tax', status: 'linked', url: 'https://eservices.burs.org.bw/burs-etax/home' });

    const admin = await officerLogin(h.app, 'admin');
    const added = await call(h.app, admin, 'POST', '/v1/officer/directory', { name: 'Thusong Family Clinic', sector: 'health', url: 'https://example.org/thusong', description: 'Book and pay in Kgotla', status: 'connected', partnerCode: 'thusong-clinic' });
    expect(added.status).toBe(201);
    expect((await call(h.app, admin, 'POST', '/v1/officer/directory', { name: 'Plain web', sector: 'other', url: 'http://insecure.example' })).status).toBe(400);
    expect((await call(h.app, admin, 'POST', '/v1/officer/directory', { name: 'BURS e-Tax', sector: 'tax', url: 'https://x.example' })).status).toBe(409);
    const upd = await call(h.app, admin, 'PUT', `/v1/officer/directory/${d.json.find((e: any) => e.name === 'FNB Botswana').id}`, { name: 'FNB Botswana', sector: 'banking', url: 'https://www.fnbbotswana.co.bw/', status: 'connecting' });
    expect(upd.status).toBe(200);
    const after = await call(h.app, null, 'GET', '/v1/directory');
    expect(after.json.find((e: any) => e.name === 'Thusong Family Clinic').partner.code).toBe('thusong-clinic');
    expect(after.json.find((e: any) => e.name === 'FNB Botswana').status).toBe('connecting');

    const naledi = await login(h.app, NALEDI);
    expect((await call(h.app, naledi, 'POST', '/v1/officer/directory', { name: 'Nope', sector: 'other', url: 'https://x.example' })).status).toBe(403);
  });
});

describe('tourism in the other country cells', () => {
  for (const [cc, parkId, id, provider] of [
    ['ZA', 'park-kruger', '9106230120087', 'South African National Parks'],
    ['NA', 'park-etosha', '89031400123', 'Ministry of Environment, Forestry and Tourism (park permits)'],
    ['ZM', 'park-south-luangwa', '234561/11/1', 'Department of National Parks and Wildlife'],
    ['ZW', 'park-hwange', '63-245718K42', 'Zimbabwe Parks and Wildlife Management Authority'],
  ] as const) {
    it(`${cc}: books ${parkId} in local currency`, async () => {
      const h = await harness({ country: cc });
      try {
        const t = await login(h.app, { omang: id, pin: '2580' });
        const before = await balance(h.app, t);
        const r = await book(h, t, { listingId: parkId, rateKey: 'citizen', startDate: plus(7), days: 1, quantity: 2 }, '2580');
        expect(r.json.status).toBe('done');
        const listing = (await call(h.app, null, 'GET', `/v1/tourism/listings/${parkId}`)).json;
        expect(listing.provider).toBe(provider);
        expect(await balance(h.app, t)).toBe(before - 2 * listing.rates[0].price);
      } finally {
        await h.close();
      }
    });
  }
});
