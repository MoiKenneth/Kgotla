import { BW } from './bw.js';
import type { Biller, CountryPack } from './types.js';
import { NA } from './na.js';
import { ZA } from './za.js';
import { ZM } from './zm.js';
import { ZW } from './zw.js';

export type { Biller, CountryPack } from './types.js';

export const PACKS: Record<string, CountryPack> = { BW, ZA, NA, ZM, ZW };

let active: CountryPack = PACKS[(process.env.KGOTLA_COUNTRY ?? 'BW').toUpperCase()] ?? BW;

/** The country pack this cell runs. */
export function country(): CountryPack {
  return active;
}

/** Select the pack (start-up and tests). One cell = one country for its whole life. */
export function useCountry(code: string): CountryPack {
  const p = PACKS[code.toUpperCase()];
  if (!p) throw new Error(`Unknown country ${code}. Available: ${Object.keys(PACKS).join(', ')}`);
  active = p;
  return p;
}

export const biller = (id: string): Biller | undefined => active.billers.find((b) => b.id === id);
export const payableBillers = () => active.billers.filter((b) => b.category !== 'airtime');
export const networks = () => active.billers.filter((b) => b.category === 'airtime');
export const electricity = () => active.billers.find((b) => b.category === 'electricity')!;

/** What the citizen app and staff tools need to render this cell. Nothing secret. */
export function publicPack(demoMode: boolean, demoOfficerPasswordHint: string | null) {
  const p = active;
  const offsetMin = (() => {
    const m = /^([+-])(\d{2}):(\d{2})$/.exec(p.utcOffset);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 120;
  })();
  return {
    code: p.code,
    name: p.name,
    currency: p.currency,
    utcOffsetMinutes: offsetMin,
    languages: p.languages,
    plannedLanguages: p.plannedLanguages,
    nationalId: { name: p.nationalId.name, short: p.nationalId.short, example: p.nationalId.example, inputMode: p.nationalId.inputMode, maxLength: p.nationalId.maxLength },
    phone: { cc: p.phone.cc, example: p.phone.example },
    ussdCode: p.ussdCode,
    agencies: { licence: p.agencies.licence, civil: p.agencies.civil, tax: p.agencies.tax },
    licence: p.licence,
    billers: p.billers.map(({ id, name, short, category, refLabel, placeholder }) => ({ id, name, short, category, refLabel, placeholder })),
    topUpSources: p.topUpSources,
    chips: p.chips,
    demo: demoMode
      ? {
          citizens: p.demo.people.filter((x) => x.pin).map((x) => ({ name: `${x.first} ${x.last}`, id: p.nationalId.display(x.id), pin: x.pin, phone: x.phone, note: x.licenceDays === 30 ? 'licence expiring in 30 days' : '' })),
          signups: p.demo.people.filter((x) => !x.pin).map((x) => ({ name: `${x.first} ${x.last}`, id: p.nationalId.display(x.id) })),
          officers: p.demo.officers.map((o) => ({ username: o.username, agency: o.agency, role: o.role })),
          officerPassword: demoOfficerPasswordHint,
          friend: p.demo.people[1]?.first ?? '',
        }
      : null,
  };
}
