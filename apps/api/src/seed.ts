import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { config } from './config.js';
import { country } from './countries/index.js';
import { createPool, one, tx } from './db.js';
import { hashIdentifier, hashSecret, randomToken } from './lib/crypto.js';
import { ensureAccount, post, walletCode } from './modules/ledger.js';
import { MockRegistry, provisionCitizen } from './modules/identity.js';
import { seedDemoPartners } from './modules/partners.js';
import { seedDirectory } from './modules/directory.js';
import { seedTourismDemo, seedTourismReference } from './modules/tourism.js';

/**
 * Reference data every cell needs, from the active country pack: billers,
 * service templates, issuers, offices, clinics. Idempotent: safe on every start.
 */
export async function seedReference(pool: pg.Pool, log = console.log): Promise<void> {
  const pack = country();
  await tx(pool, async (c) => {
    for (const b of pack.billers) {
      await c.query(
        `INSERT INTO billers (id, name, category, ref_label, ref_pattern) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, ref_label = EXCLUDED.ref_label, ref_pattern = EXCLUDED.ref_pattern`,
        [b.id, b.name, b.category, b.refLabel, b.refPattern],
      );
    }

    for (const t of pack.services) {
      await c.query(
        `INSERT INTO service_templates (code, name, agency, fee, steps, output) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, agency = EXCLUDED.agency, fee = EXCLUDED.fee, steps = EXCLUDED.steps, output = EXCLUDED.output`,
        [t.code, t.name, t.agency, t.fee, JSON.stringify(t.steps), JSON.stringify(t.output)],
      );
      await ensureAccount(c, `payable:agency:${t.agency}`, 'liability', `Fees payable · ${t.agency}`);
    }

    for (const l of pack.locations) {
      await c.query(
        `INSERT INTO locations (id, kind, name, agency, capacity, slot_times, services, counter_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, capacity = EXCLUDED.capacity, slot_times = EXCLUDED.slot_times, services = EXCLUDED.services, counter_count = EXCLUDED.counter_count`,
        [l.id, l.kind, l.name, l.agency, l.capacity, l.slots, l.services, l.counters],
      );
    }

    await seedDirectory(c);
    await seedTourismReference(c);

    const a = pack.agencies;
    const issuers = new Map<string, string>();
    for (const ag of [a.civil, a.licence, a.tax, a.exams, a.health, a.immigration]) issuers.set(ag.code, ag.name);
    for (const s of pack.services) if (!issuers.has(s.output.issuer)) issuers.set(s.output.issuer, s.output.issuer);
    for (const [id, name] of issuers) {
      if (await one(c, 'SELECT 1 FROM issuers WHERE id = $1', [id])) continue;
      const key = config.demoMode ? `demo-issuer-key-${id.toLowerCase()}` : randomToken(24);
      await c.query('INSERT INTO issuers (id, name, api_key_hash) VALUES ($1,$2,$3)', [id, name, await hashSecret(key)]);
      log(`issuer ${id} created · API key: ${key}${config.demoMode ? ' (demo)' : ' — store it now, it is not shown again'}`);
    }
  });
}

/**
 * Live cells: create the first Kgotla admin from ADMIN_BOOTSTRAP_PASSWORD (kept in
 * Key Vault) if no admin exists yet. The admin then creates other officer accounts.
 */
export async function seedAdmin(pool: pg.Pool, log = console.log): Promise<void> {
  const pw = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!pw || pw === 'unset' || pw.length < 12) return;
  if (await one(pool, `SELECT 1 FROM officers WHERE role = 'admin'`)) return;
  await pool.query(`INSERT INTO officers (username, name, agency, role, password_hash) VALUES ('admin', 'Kgotla administrator', 'KGOTLA', 'admin', $1)`, [await hashSecret(pw)]);
  log('created the first admin account "admin" (password from ADMIN_BOOTSTRAP_PASSWORD)');
}

/** Password for demo officer accounts: from the environment (cloud cells), else a well-known demo value. */
export const demoOfficerPassword = () => process.env.DEMO_OFFICER_PASSWORD || 'kgotla-demo';

/** Example registry people, enrolled citizens and officers for the active country. Demo mode only. */
export async function seedDemo(pool: pg.Pool, log = console.log): Promise<void> {
  if (!config.demoMode) throw new Error('seedDemo runs only in DEMO_MODE');
  const pack = country();
  await tx(pool, async (c) => {
    for (const p of pack.demo.people) {
      const validTo = p.licenceDays == null ? null : new Date(Date.now() + p.licenceDays * 86400_000).toISOString().slice(0, 10);
      await c.query(
        `INSERT INTO registry_mock.people (omang, first_name, last_name, dob, sex, district, phone, licence_class, licence_valid_to, tax_compliant)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (omang) DO NOTHING`,
        [p.id, p.first, p.last, p.dob, p.sex, p.district, p.phone, p.licenceClass, validTo, p.taxCompliant],
      );
    }
    const reg = new MockRegistry(c);
    for (const person of pack.demo.people.filter((x) => x.pin)) {
      const h = hashIdentifier(person.id);
      if (await one(c, 'SELECT 1 FROM citizens WHERE omang_hash = $1', [h])) continue;
      const p = (await reg.lookup(person.id))!;
      const row = await one<any>(
        c,
        `INSERT INTO citizens (omang_hash, omang_last4, first_name, last_name, dob, district, phone, loa, pin_hash, lang)
         VALUES ($1,$2,$3,$4,$5,$6,$7,3,$8,$9) RETURNING id`,
        [h, person.id.replace(/\W/g, '').slice(-4), p.firstName, p.lastName, p.dob, p.district, p.phone, await hashSecret(person.pin!), pack.languages[0].code],
      );
      await provisionCitizen(c, row.id, p);
      log(`demo citizen ${p.firstName} ${p.lastName} · ${pack.nationalId.short} ${pack.nationalId.display(person.id)} · PIN ${person.pin}`);
    }

    // A little history for the first demo citizen: an electricity purchase and a transfer.
    const [first, second] = pack.demo.people;
    const a = await one<any>(c, 'SELECT id FROM citizens WHERE omang_hash = $1', [hashIdentifier(first.id)]);
    const b = await one<any>(c, 'SELECT id FROM citizens WHERE omang_hash = $1', [hashIdentifier(second.id)]);
    if (a && b) {
      const elec = pack.billers.find((x) => x.category === 'electricity')!;
      const scale = pack.limits.demoCredit / 250000; // keep the history proportionate to the currency
      await ensureAccount(c, `payable:biller:${elec.id}`, 'liability', `Payable · ${elec.name}`);
      await post(c, {
        kind: 'bill',
        description: `${elec.name} · ${pack.demo.meter}`,
        idempotencyKey: `demo-history:${elec.id}`,
        lines: [
          { account: walletCode(a.id), amount: Math.round(30000 * scale) },
          { account: `payable:biller:${elec.id}`, amount: -Math.round(30000 * scale) },
        ],
      });
      await post(c, {
        kind: 'p2p',
        description: `Sent to ${second.first} ${second.last}`,
        idempotencyKey: 'demo-history:p2p',
        meta: { to: b.id },
        lines: [
          { account: walletCode(a.id), amount: Math.round(15000 * scale) },
          { account: walletCode(b.id), amount: -Math.round(15000 * scale) },
        ],
      });
    }

    const password = demoOfficerPassword();
    for (const o of pack.demo.officers) {
      if (await one(c, 'SELECT 1 FROM officers WHERE username = $1', [o.username])) continue;
      await c.query('INSERT INTO officers (username, name, agency, role, password_hash) VALUES ($1,$2,$3,$4,$5)', [o.username, o.name, o.agency, o.role, await hashSecret(password)]);
      log(`demo officer ${o.username} (${o.agency} ${o.role})${process.env.DEMO_OFFICER_PASSWORD ? '' : ` · password ${password}`}`);
    }

    // Partners: an approved clinic and bank, and a doctor waiting for review.
    await seedDemoPartners(c, password, log, a?.id);
    // Tourism: parks with demo fees, the demo hotel's and tour operator's listings, a park gate officer.
    await seedTourismDemo(c, password, log);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pool = createPool();
  (async () => {
    const { migrate } = await import('./migrate.js');
    await migrate(pool);
    await seedReference(pool);
    if (config.demoMode) await seedDemo(pool);
    await pool.end();
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
