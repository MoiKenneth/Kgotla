/**
 * A country pack holds everything that differs between Kgotla country cells:
 * identity rules, phone numbers, money, agencies, services and fees, billers,
 * networks, offices and demo data. Code stays the same everywhere; each cell
 * runs with exactly one pack (KGOTLA_COUNTRY).
 *
 * Agency names, fees and formats here are a starting point for each country's
 * due diligence. Every entry marked "demo" must be confirmed with the owning
 * institution before a pilot.
 */

export interface Agency {
  code: string; // short code used in workflows and officer accounts, e.g. DRTS
  name: string;
}

export interface NationalIdRule {
  /** What citizens call it: "Omang number", "ID number", "NRC number". */
  name: string;
  /** Short label for compact UI: "Omang", "SA ID", "NRC". */
  short: string;
  /** Title of the identity document issued into the Vault at enrolment. */
  documentTitle: string;
  example: string;
  inputMode: 'numeric' | 'text';
  maxLength: number;
  /** Error shown when the format is wrong. */
  error: string;
  /** Domain-separation prefix for the keyed hash. Never change for a live cell. */
  hashPrefix: string;
  /** Canonical form, or null when the input is not a valid number. */
  normalise(raw: string): string | null;
  /** How to print a canonical number. */
  display(canonical: string): string;
}

export interface PhoneRule {
  cc: string; // country calling code without +
  nsn: number; // national significant number length
  trunk: boolean; // national format starts with 0
  example: string; // what a citizen types, e.g. "71 234 567"
}

export interface Biller {
  id: string;
  name: string;
  short: string;
  category: 'electricity' | 'water' | 'airtime';
  refLabel: string;
  refPattern: string; // regex on the reference with spaces removed
  placeholder: string;
}

export interface TopUpSource {
  id: string;
  name: string;
}

export interface Location {
  id: string;
  kind: 'eye_test' | 'clinic' | 'passport' | 'office';
  name: string;
  agency: string;
  capacity: number;
  slots: string[];
  services: string[];
  counters: number;
}

export interface Step {
  key: string;
  label: string;
  label_tn?: string;
}

export interface ServiceTemplate {
  code: 'driver_licence_renewal' | 'birth_certificate_copy' | 'tax_clearance';
  name: string;
  agency: string;
  fee: number; // minor units
  steps: Step[];
  output: { type: string; title: string; issuer: string; validYears?: number; validDays?: number };
}

export interface DemoPerson {
  id: string; // canonical national ID
  first: string;
  last: string;
  dob: string;
  sex: 'F' | 'M';
  district: string;
  phone: string; // E.164
  licenceClass: string | null;
  licenceDays: number | null; // licence valid for this many days from today
  taxCompliant: boolean;
  pin?: string; // present = already enrolled in demo data
}

export interface CountryPack {
  code: 'BW' | 'ZA' | 'NA' | 'ZM' | 'ZW';
  name: string;
  /** Who the assistant serves: "Botswana's", "South Africa's". */
  possessive: string;
  phase: number; // blueprint roll-out phase
  currency: { code: string; symbol: string; minorName: string };
  utcOffset: string;
  languages: { code: string; name: string }[];
  /** Languages on the roadmap for this cell (need native-speaker translation first). */
  plannedLanguages: string[];
  nationalId: NationalIdRule;
  phone: PhoneRule;
  ussdCode: string;
  agencies: { licence: Agency; civil: Agency; tax: Agency; immigration: Agency; health: Agency; exams: Agency };
  licence: { classWord: string; collectAt: string };
  services: ServiceTemplate[];
  billers: Biller[];
  topUpSources: TopUpSource[];
  locations: Location[];
  limits: { transferMax: number; billMin: number; airtimeMin: number; airtimeMax: number; topUpMax: number; demoCredit: number };
  chips: { send: number[]; bills: number[]; airtime: number[]; topup: number[] };
  demo: {
    people: DemoPerson[];
    officers: { username: string; name: string; agency: string; role: 'caseworker' | 'counter' | 'admin' }[];
    /** Example meter / account references for the demo history and forms. */
    meter: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers shared by the packs
// ---------------------------------------------------------------------------

export const digits = (s: string) => String(s ?? '').replace(/\D/g, '');

/** YYMMDD → is a real calendar date. */
export function validYYMMDD(s: string): boolean {
  const y = Number(s.slice(0, 2));
  const m = Number(s.slice(2, 4));
  const d = Number(s.slice(4, 6));
  if (m < 1 || m > 12 || d < 1) return false;
  const full = (y > 30 ? 1900 : 2000) + y;
  return d <= new Date(Date.UTC(full, m, 0)).getUTCDate();
}

/** Luhn mod-10 check over the whole number (South African ID numbers). */
export function luhnValid(num: string): boolean {
  let sum = 0;
  for (let i = 0; i < num.length; i++) {
    let d = Number(num[num.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Standard licence-renewal steps with the agency's name filled in. */
export function licenceSteps(agency: string, tn = false): Step[] {
  return [
    { key: 'submitted', label: 'Submitted', ...(tn ? { label_tn: 'E rometswe' } : {}) },
    { key: 'eye_test', label: 'Eye test passed', ...(tn ? { label_tn: 'Tlhatlhobo ya matlho e feditswe' } : {}) },
    { key: 'approved', label: `Approved by ${agency}`, ...(tn ? { label_tn: `E amogetswe ke ${agency}` } : {}) },
    { key: 'issued', label: 'Licence issued to your Vault', ...(tn ? { label_tn: 'Laesense e mo Polokelong' } : {}) },
  ];
}
