import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { country, PACKS, useCountry } from '../src/countries/index.js';
import { luhnValid } from '../src/countries/types.js';
import { fmt, toThebe } from '../src/lib/money.js';
import { assertCell } from '../src/migrate.js';
import { trialBalance } from '../src/modules/ledger.js';
import { maskPhone, normalisePhone } from '../src/modules/identity.js';
import type { LlmClient } from '../src/modules/assistant.js';
import { balance, call, harness, officerLogin, type Harness } from './helpers.js';

describe('national ID rules', () => {
  it('South Africa: 13 digits, real birth date, Luhn check digit', () => {
    const id = PACKS.ZA.nationalId;
    expect(id.normalise('910623 0120 087')).toBe('9106230120087');
    expect(id.normalise('9106230120088')).toBeNull(); // wrong check digit
    expect(id.normalise('9113230120087')).toBeNull(); // month 13
    expect(luhnValid('8804125126083')).toBe(true);
  });
  it('Namibia: 11 digits starting with a real date', () => {
    expect(PACKS.NA.nationalId.normalise('890314 00123')).toBe('89031400123');
    expect(PACKS.NA.nationalId.normalise('89023100123')).toBeNull(); // 31 Feb
  });
  it('Zambia: NRC in any spacing becomes 123456/78/1', () => {
    expect(PACKS.ZM.nationalId.normalise('234561 11 1')).toBe('234561/11/1');
    expect(PACKS.ZM.nationalId.normalise('234561/11')).toBeNull();
  });
  it('Zimbabwe: 63-245718K42 in any case or spacing', () => {
    expect(PACKS.ZW.nationalId.normalise('63-245718 k42')).toBe('63245718K42');
    expect(PACKS.ZW.nationalId.display('63245718K42')).toBe('63-245718K42');
    expect(PACKS.ZW.nationalId.normalise('63-245718-42')).toBeNull();
  });
  it('Botswana is unchanged: 9-digit Omang', () => {
    expect(PACKS.BW.nationalId.normalise('435 721 904')).toBe('435721904');
    expect(PACKS.BW.nationalId.normalise('43572190')).toBeNull();
  });
});

describe('phones and money per country', () => {
  it.each([
    ['BW', '71 234 558', '+26771234558', 'P 1,234.50'],
    ['ZA', '082 123 4567', '+27821234567', 'R 1,234.50'],
    ['NA', '081 123 4558', '+264811234558', 'N$ 1,234.50'],
    ['ZM', '097 123 4558', '+260971234558', 'K 1,234.50'],
    ['ZW', '077 123 4558', '+263771234558', 'US$ 1,234.50'],
  ])('%s', (code, typed, e164, money) => {
    useCountry(code);
    expect(normalisePhone(typed)).toBe(e164);
    expect(normalisePhone(e164)).toBe(e164);
    expect(maskPhone(e164).endsWith('•• •• ' + e164.slice(-2))).toBe(true);
    expect(fmt(123450)).toBe(money);
    expect(toThebe(`${country().currency.symbol} 12.50`)).toBe(1250);
  });
});

for (const code of ['ZA', 'NA', 'ZM', 'ZW']) {
  describe(`${PACKS[code].name} cell end to end`, () => {
    let h: Harness;
    let tools: any[] = [];
    const fakeClaude: LlmClient = {
      messages: {
        create: async (req: any) => {
          tools = req.tools;
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
        },
      },
    };
    const pack = PACKS[code];
    const [first, second] = pack.demo.people;
    const signup = pack.demo.people.find((p) => !p.pin && !p.taxCompliant)!;

    beforeAll(async () => {
      h = await harness({ country: code, llm: fakeClaude });
    });
    afterAll(() => h.close());

    it('serves its pack to the apps', async () => {
      const cfg = (await call(h.app, null, 'GET', '/v1/config')).json;
      expect(cfg.country).toBe(code);
      expect(cfg.pack.currency.symbol).toBe(pack.currency.symbol);
      expect(cfg.pack.nationalId.short).toBe(pack.nationalId.short);
      expect(cfg.pack.demo.citizens[0].id).toBe(pack.nationalId.display(first.id));
    });

    it('signs in with the local ID format, pays the local utility and sends money', async () => {
      const login = await call(h.app, null, 'POST', '/v1/auth/login', { nationalId: pack.nationalId.display(first.id), pin: first.pin });
      expect(login.status).toBe(200);
      const t = login.json.token;
      const me = (await call(h.app, t, 'GET', '/v1/me')).json;
      expect(me.balanceText.startsWith(pack.currency.symbol + ' ')).toBe(true);
      expect(me.documents.map((d: any) => d.title)).toContain(pack.nationalId.documentTitle);

      const elec = pack.billers.find((b) => b.category === 'electricity')!;
      const bill = (await call(h.app, t, 'POST', '/v1/actions', { type: 'pay_bill', params: { biller: elec.id, ref: '04127788330', amount: pack.chips.bills[1] } })).json;
      expect(bill.readback).toContainEqual(['To', elec.name]);
      const paid = (await call(h.app, t, 'POST', `/v1/actions/${bill.id}/confirm`, { pin: first.pin })).json;
      expect(paid.result.token.replace(/\s/g, '')).toMatch(/^\d{20}$/);

      // A Botswana biller does not exist here.
      expect((await call(h.app, t, 'POST', '/v1/actions', { type: 'pay_bill', params: { biller: 'bpc', ref: '04127788330', amount: 50 } })).status).toBe(400);

      // Send to the second person, typed in national format with the trunk 0.
      const national = '0' + second.phone.slice(pack.phone.cc.length + 1);
      const before = await balance(h.app, t);
      const send = (await call(h.app, t, 'POST', '/v1/actions', { type: 'send_money', params: { to: national, amount: pack.chips.send[0] } })).json;
      expect(send.readback).toContainEqual(['To', `${second.first} ${second.last[0]}.`]);
      await call(h.app, t, 'POST', `/v1/actions/${send.id}/confirm`, { pin: first.pin });
      expect(await balance(h.app, t)).toBe(before - pack.chips.send[0] * 100);

      const net = pack.billers.find((b) => b.category === 'airtime')!;
      const air = (await call(h.app, t, 'POST', '/v1/actions', { type: 'buy_airtime', params: { network: net.id, amount: pack.chips.airtime[0] } })).json;
      expect(air.readback).toContainEqual(['Network', net.name]);
      const src = pack.topUpSources[0];
      const top = (await call(h.app, t, 'POST', '/v1/actions', { type: 'top_up', params: { source: src.id, amount: pack.chips.topup[0] } })).json;
      expect(top.readback).toContainEqual(['From', src.name]);
    });

    it("renews a licence through the country's own agency", async () => {
      const t = (await call(h.app, null, 'POST', '/v1/auth/login', { nationalId: first.id, pin: first.pin })).json.token;
      const eye = pack.locations.find((l) => l.kind === 'eye_test')!;
      const avail = (await call(h.app, t, 'GET', `/v1/locations/${eye.id}/availability`)).json;
      const startsAt = avail.days[0].slots.find((s: any) => s.available).startsAt;
      const a = (await call(h.app, t, 'POST', '/v1/actions', { type: 'licence_renewal', params: { eyeTest: { locationId: eye.id, startsAt } } })).json;
      const fee = pack.services.find((s) => s.code === 'driver_licence_renewal')!.fee;
      expect(a.amountText).toBe(fmt(fee));
      expect(a.readback).toContainEqual(['Collect card at', pack.licence.collectAt]);
      const done = (await call(h.app, t, 'POST', `/v1/actions/${a.id}/confirm`, { pin: first.pin })).json;

      const officer = pack.demo.officers.find((o) => o.agency === pack.agencies.licence.code && o.role === 'caseworker')!;
      const ot = await officerLogin(h.app, officer.username);
      for (let i = 0; i < 3; i++) expect((await call(h.app, ot, 'POST', `/v1/officer/applications/${done.result.applicationId}/advance`, {})).status).toBe(200);
      const me = (await call(h.app, t, 'GET', '/v1/me')).json;
      const lic = me.documents.filter((d: any) => d.type === 'driver_licence');
      expect(lic).toHaveLength(1);
      expect(lic[0].title).toContain(`${pack.licence.classWord} ${first.licenceClass}`);
      expect(lic[0].issuer).toBe(pack.agencies.licence.name);
    });

    it('enrols a new person and refuses a tax certificate when the tax office shows arrears', async () => {
      const s = (await call(h.app, null, 'POST', '/v1/enrol/start', { nationalId: pack.nationalId.display(signup.id) })).json;
      await call(h.app, null, 'POST', `/v1/enrol/${s.enrolmentId}/otp`, { code: s.demoOtp });
      await call(h.app, null, 'POST', `/v1/enrol/${s.enrolmentId}/liveness`, { selfie: Buffer.alloc(4096, 1).toString('base64') });
      const done = (await call(h.app, null, 'POST', `/v1/enrol/${s.enrolmentId}/complete`, { pin: '7391', lang: 'tn' })).json;
      const me = (await call(h.app, done.token, 'GET', '/v1/me')).json;
      expect(me.profile.lang).toBe('en'); // Setswana is a Botswana-cell language
      const r = (await call(h.app, done.token, 'POST', '/v1/actions', { type: 'tax_clearance', params: {} })).json;
      expect(r.error.code).toBe('not_compliant');
      expect(r.error.message).toContain(pack.agencies.tax.code);
    });

    it('USSD shows the local currency and utility', async () => {
      const ussd = (text: string) =>
        h.app.inject({ method: 'POST', url: '/v1/ussd', payload: { sessionId: `s-${code}`, phoneNumber: first.phone, text } }).then((r) => r.body);
      expect(await ussd('')).toContain(`Buy electricity (${pack.billers.find((b) => b.category === 'electricity')!.short})`);
      expect(await ussd(`2*${first.pin}`)).toContain(pack.currency.symbol + ' ');
    });

    it("gives the assistant only this country's providers", async () => {
      const t = (await call(h.app, null, 'POST', '/v1/auth/login', { nationalId: first.id, pin: first.pin })).json.token;
      await call(h.app, t, 'POST', '/v1/assistant', { messages: [{ role: 'user', content: 'hello' }] });
      const bill = tools.find((x) => x.name === 'propose_bill_payment');
      expect(bill.input_schema.properties.biller.enum).toEqual(pack.billers.filter((b) => b.category !== 'airtime').map((b) => b.id));
      expect(tools.find((x) => x.name === 'propose_top_up').input_schema.properties.source.enum).toEqual(pack.topUpSources.map((s) => s.id));
    });

    it('keeps the books balanced and refuses to run as another country', async () => {
      expect(await trialBalance(h.pool)).toBe(0);
      await expect(assertCell(h.pool, 'BW')).rejects.toThrow(/belongs to the/);
    });
  });
}
