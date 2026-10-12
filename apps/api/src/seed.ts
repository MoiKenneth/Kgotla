import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { config } from './config.js';
import { createPool, one, tx } from './db.js';
import { hashIdentifier, hashSecret, randomToken } from './lib/crypto.js';
import { ensureAccount, post, walletCode } from './modules/ledger.js';
import { MockRegistry, provisionCitizen } from './modules/identity.js';

/**
 * Reference data every cell needs: billers, service templates, issuers,
 * offices, clinics. Idempotent: safe to run on every start.
 */
export async function seedReference(pool: pg.Pool, log = console.log): Promise<void> {
  await tx(pool, async (c) => {
    const billers = [
      ['bpc', 'BPC prepaid electricity', 'electricity', 'Meter number', '^\\d{11}$'],
      ['wuc', 'Water Utilities Corporation', 'water', 'Account number', '^WUC-\\d{3}-\\d{5}$'],
      ['mascom', 'Mascom', 'airtime', 'Phone number', '.*'],
      ['orange', 'Orange', 'airtime', 'Phone number', '.*'],
      ['btc', 'BTC', 'airtime', 'Phone number', '.*'],
    ];
    for (const b of billers) {
      await c.query(
        `INSERT INTO billers (id, name, category, ref_label, ref_pattern) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, ref_label = EXCLUDED.ref_label, ref_pattern = EXCLUDED.ref_pattern`,
        b,
      );
    }

    const templates = [
      {
        code: 'driver_licence_renewal',
        name: "Driver's licence renewal",
        agency: 'DRTS',
        fee: 15000,
        steps: [
          { key: 'submitted', label: 'Submitted', label_tn: 'E rometswe' },
          { key: 'eye_test', label: 'Eye test passed', label_tn: 'Tlhatlhobo ya matlho e feditswe' },
          { key: 'approved', label: 'Approved by DRTS', label_tn: 'E amogetswe ke DRTS' },
          { key: 'issued', label: 'Licence issued to your Vault', label_tn: 'Laesense e mo Polokelong' },
        ],
        output: { type: 'driver_licence', title: "Driver's licence · Class {licence_class}", issuer: 'DRTS', validYears: 5 },
      },
      {
        code: 'birth_certificate_copy',
        name: 'Birth certificate copy',
        agency: 'CNR',
        fee: 1000,
        steps: [
          { key: 'submitted', label: 'Submitted', label_tn: 'E rometswe' },
          { key: 'processing', label: 'Being processed by Civil Registration', label_tn: 'E a dirwa' },
          { key: 'issued', label: 'Copy issued to your Vault', label_tn: 'Kopi e mo Polokelong' },
        ],
        output: { type: 'birth_certificate', title: 'Birth certificate · {name}', issuer: 'CNR' },
      },
      {
        code: 'tax_clearance',
        name: 'Tax clearance certificate',
        agency: 'BURS',
        fee: 0,
        steps: [{ key: 'issued', label: 'Certificate issued to your Vault', label_tn: 'Setlankana se mo Polokelong' }],
        output: { type: 'tax_clearance', title: 'Tax clearance certificate', issuer: 'BURS', validDays: 90 },
      },
    ];
    for (const t of templates) {
      await c.query(
        `INSERT INTO service_templates (code, name, agency, fee, steps, output) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, agency = EXCLUDED.agency, fee = EXCLUDED.fee, steps = EXCLUDED.steps, output = EXCLUDED.output`,
        [t.code, t.name, t.agency, t.fee, JSON.stringify(t.steps), JSON.stringify(t.output)],
      );
      await ensureAccount(c, `payable:agency:${t.agency}`, 'liability', `Fees payable · ${t.agency}`);
    }

    const locations = [
      ['eye-gbe-drts', 'eye_test', 'DRTS eye-test room · Gaborone', 'DRTS', 3, ['08:30', '09:30', '11:00', '14:00', '15:00'], [], 1],
      ['eye-gbw-opt', 'eye_test', 'Partner optometrist · Gaborone West', 'DRTS', 2, ['09:00', '10:30', '15:15'], [], 1],
      ['clinic-bontleng', 'clinic', 'Bontleng Clinic', 'MOH', 4, ['08:00', '08:30', '09:30', '10:30', '14:00', '15:00'], [], 1],
      ['clinic-broadhurst', 'clinic', 'Broadhurst Clinic', 'MOH', 4, ['08:00', '09:00', '10:00', '14:00', '15:30'], [], 1],
      ['clinic-oldnaledi', 'clinic', 'Old Naledi Clinic', 'MOH', 4, ['08:00', '08:30', '09:30', '11:00', '14:30'], [], 1],
      ['imm-gbe', 'passport', 'Immigration · Gaborone HQ', 'DIC', 3, ['08:15', '09:00', '10:45', '13:30'], [], 1],
      ['imm-ftw', 'passport', 'Immigration · Francistown', 'DIC', 2, ['08:30', '10:00', '14:00'], [], 1],
      ['drts-mainmall', 'office', 'DRTS · Gaborone Main Mall', 'DRTS', 1, [], ['Licence collection', 'Vehicle registration'], 4],
      ['cnr-gbe', 'office', 'Civil & National Registration · Gaborone', 'CNR', 1, [], ['Omang replacement', 'Birth registration'], 3],
      ['burs-gbe', 'office', 'BURS · Gaborone', 'BURS', 1, [], ['Tax returns', 'PAYE queries'], 2],
      ['dc-serowe', 'office', 'District Commissioner · Serowe', 'DC', 1, [], ['General enquiry', 'Land board referral'], 1],
    ];
    for (const l of locations) {
      await c.query(
        `INSERT INTO locations (id, kind, name, agency, capacity, slot_times, services, counter_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, capacity = EXCLUDED.capacity, slot_times = EXCLUDED.slot_times, services = EXCLUDED.services, counter_count = EXCLUDED.counter_count`,
        l,
      );
    }

    const issuers = [
      ['CNR', 'Civil & National Registration'],
      ['DRTS', 'Department of Road Transport & Safety'],
      ['BURS', 'Botswana Unified Revenue Service'],
      ['BEC', 'Botswana Examinations Council'],
      ['MOH', 'Ministry of Health'],
    ];
    for (const [id, name] of issuers) {
      const exists = await one(c, 'SELECT 1 FROM issuers WHERE id = $1', [id]);
      if (exists) continue;
      const key = config.demoMode ? `demo-issuer-key-${id.toLowerCase()}` : randomToken(24);
      await c.query('INSERT INTO issuers (id, name, api_key_hash) VALUES ($1,$2,$3)', [id, name, await hashSecret(key)]);
      log(`issuer ${id} created · API key: ${key}${config.demoMode ? ' (demo)' : ' — store it now, it is not shown again'}`);
    }
  });
}

/** Example registry people, enrolled citizens and officers. Demo mode only. */
export const DEMO = {
  people: [
    // omang, first, last, dob, sex, district, phone, licence class, licence valid days from today, tax compliant
    ['435721904', 'Naledi', 'Mothibi', '1991-03-14', 'F', 'Gaborone', '+26771234558', 'B', 30, true],
    ['512810117', 'Mpho', 'Kgosi', '1988-07-02', 'M', 'Gaborone', '+26772345614', null, null, true],
    ['287410556', 'Kabelo', 'Seretse', '1995-11-21', 'M', 'Francistown', '+26774345630', 'B', 900, true],
    ['619225381', 'Lesego', 'Mothibi', '1965-05-09', 'F', 'Serowe', '+26771456702', null, null, true],
    ['341926728', 'Onkemetse', 'Dikgang', '2001-02-17', 'F', 'Maun', '+26775567811', 'B', 400, false],
    ['778215043', 'Tumelo', 'Ramotswa', '1979-09-30', 'M', 'Molepolole', '+26776678922', 'C', 1200, true],
  ] as const,
  enrolled: [
    ['435721904', '2580'],
    ['512810117', '1357'],
    ['287410556', '2468'],
    ['619225381', '1470'],
  ] as const,
  officers: [
    ['drts.case', 'Kagiso Molefe', 'DRTS', 'caseworker'],
    ['cnr.case', 'Boitumelo Phiri', 'CNR', 'caseworker'],
    ['burs.case', 'Thato Kebonang', 'BURS', 'caseworker'],
    ['drts.counter', 'Oratile Sebina', 'DRTS', 'counter'],
    ['admin', 'Kgotla Operations', 'KGOTLA', 'admin'],
  ] as const,
  officerPassword: 'kgotla-demo',
};

export async function seedDemo(pool: pg.Pool, log = console.log): Promise<void> {
  if (!config.demoMode) throw new Error('seedDemo runs only in DEMO_MODE');
  await tx(pool, async (c) => {
    for (const p of DEMO.people) {
      const validTo = p[8] == null ? null : new Date(Date.now() + Number(p[8]) * 86400_000).toISOString().slice(0, 10);
      await c.query(
        `INSERT INTO registry_mock.people (omang, first_name, last_name, dob, sex, district, phone, licence_class, licence_valid_to, tax_compliant)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (omang) DO NOTHING`,
        [p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], validTo, p[9]],
      );
    }
    const reg = new MockRegistry(c);
    for (const [omang, pin] of DEMO.enrolled) {
      const h = hashIdentifier(omang);
      if (await one(c, 'SELECT 1 FROM citizens WHERE omang_hash = $1', [h])) continue;
      const p = (await reg.lookup(omang))!;
      const row = await one<any>(
        c,
        `INSERT INTO citizens (omang_hash, omang_last4, first_name, last_name, dob, district, phone, loa, pin_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,3,$8) RETURNING id`,
        [h, omang.slice(-4), p.firstName, p.lastName, p.dob, p.district, p.phone, await hashSecret(pin)],
      );
      await provisionCitizen(c, row.id, p);
      log(`demo citizen ${p.firstName} ${p.lastName} · Omang ${omang} · PIN ${pin}`);
    }
    // A little history for the first demo citizen.
    const naledi = await one<any>(c, 'SELECT id FROM citizens WHERE omang_hash = $1', [hashIdentifier('435721904')]);
    const mpho = await one<any>(c, 'SELECT id FROM citizens WHERE omang_hash = $1', [hashIdentifier('512810117')]);
    if (naledi && mpho) {
      await ensureAccount(c, 'payable:biller:bpc', 'liability', 'Payable · BPC');
      await post(c, {
        kind: 'bill',
        description: 'BPC prepaid electricity · 04127788330',
        idempotencyKey: 'demo-history:bpc',
        lines: [
          { account: walletCode(naledi.id), amount: 30000 },
          { account: 'payable:biller:bpc', amount: -30000 },
        ],
      });
      await post(c, {
        kind: 'p2p',
        description: 'Sent to Mpho Kgosi',
        idempotencyKey: 'demo-history:p2p',
        meta: { to: mpho.id },
        lines: [
          { account: walletCode(naledi.id), amount: 15000 },
          { account: walletCode(mpho.id), amount: -15000 },
        ],
      });
    }
    for (const [username, name, agency, role] of DEMO.officers) {
      if (await one(c, 'SELECT 1 FROM officers WHERE username = $1', [username])) continue;
      await c.query('INSERT INTO officers (username, name, agency, role, password_hash) VALUES ($1,$2,$3,$4,$5)', [
        username,
        name,
        agency,
        role,
        await hashSecret(DEMO.officerPassword),
      ]);
      log(`demo officer ${username} (${agency} ${role}) · password ${DEMO.officerPassword}`);
    }
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
