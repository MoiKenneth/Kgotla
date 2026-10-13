import { licenceSteps, type CountryPack } from './types.js';

/**
 * Zimbabwe: Phase 2 cell. The wallet runs in US dollars, which most everyday
 * transactions use; ZiG (ZWG) is also legal tender. A second ZWG wallet is a
 * roadmap item (the ledger already supports any number of accounts). Fees are demo values.
 */
export const ZW: CountryPack = {
  code: 'ZW',
  name: 'Zimbabwe',
  possessive: "Zimbabwe's",
  phase: 2,
  currency: { code: 'USD', symbol: 'US$', minorName: 'cents' },
  utcOffset: '+02:00',
  languages: [{ code: 'en', name: 'English' }],
  plannedLanguages: ['Shona', 'Ndebele'],
  nationalId: {
    name: 'National ID number',
    short: 'ZW ID',
    documentTitle: 'Zimbabwe national ID card',
    example: '63-245718K42',
    inputMode: 'text',
    maxLength: 15,
    error: 'A Zimbabwe ID number looks like 63-245718K42',
    hashPrefix: 'zw-id:',
    // District code (2 digits), serial (6-7 digits), check letter, district of origin (2 digits).
    // The check letter itself is not yet verified: confirm the algorithm with the Registrar General.
    normalise: (raw) => {
      const s = String(raw ?? '').toUpperCase().replace(/[\s-]/g, '');
      return /^\d{8,9}[A-Z]\d{2}$/.test(s) ? s : null;
    },
    display: (id) => `${id.slice(0, 2)}-${id.slice(2)}`,
  },
  phone: { cc: '263', nsn: 9, trunk: true, example: '077 123 4567' },
  ussdCode: '*321#',
  agencies: {
    licence: { code: 'VID', name: 'Vehicle Inspection Department' },
    civil: { code: 'RG', name: "Registrar General's Department" },
    tax: { code: 'ZIMRA', name: 'Zimbabwe Revenue Authority' },
    immigration: { code: 'RG', name: "Registrar General's Department" },
    health: { code: 'MOHCC', name: 'Ministry of Health and Child Care' },
    exams: { code: 'ZIMSEC', name: 'Zimbabwe School Examinations Council' },
  },
  licence: { classWord: 'Class', collectAt: 'VID · Harare' },
  services: [
    {
      code: 'driver_licence_renewal',
      name: "Driver's licence renewal",
      agency: 'VID',
      fee: 2000,
      steps: licenceSteps('VID'),
      output: { type: 'driver_licence', title: "Driver's licence · Class {licence_class}", issuer: 'VID', validYears: 5 },
    },
    {
      code: 'birth_certificate_copy',
      name: 'Birth certificate copy',
      agency: 'RG',
      fee: 500,
      steps: [
        { key: 'submitted', label: 'Submitted' },
        { key: 'processing', label: "Being processed by the Registrar General's office" },
        { key: 'issued', label: 'Copy issued to your Vault' },
      ],
      output: { type: 'birth_certificate', title: 'Birth certificate · {name}', issuer: 'RG' },
    },
    {
      code: 'tax_clearance',
      name: 'Tax clearance certificate (ITF263)',
      agency: 'ZIMRA',
      fee: 0,
      steps: [{ key: 'issued', label: 'Certificate issued to your Vault' }],
      output: { type: 'tax_clearance', title: 'Tax clearance certificate ITF263 (ZIMRA)', issuer: 'ZIMRA', validDays: 90 },
    },
  ],
  billers: [
    { id: 'zetdc', name: 'ZETDC prepaid electricity (ZESA)', short: 'ZESA', category: 'electricity', refLabel: 'Meter number', refPattern: '^\\d{11,13}$', placeholder: '0412 7788 3301' },
    { id: 'hararewater', name: 'City of Harare water and rates', short: 'Harare water', category: 'water', refLabel: 'Account number', refPattern: '^\\d{6,12}$', placeholder: '4402918' },
    { id: 'econet', name: 'Econet', short: 'Econet', category: 'airtime', refLabel: 'Phone number', refPattern: '.*', placeholder: '' },
    { id: 'netone', name: 'NetOne', short: 'NetOne', category: 'airtime', refLabel: 'Phone number', refPattern: '.*', placeholder: '' },
    { id: 'telecel', name: 'Telecel', short: 'Telecel', category: 'airtime', refLabel: 'Phone number', refPattern: '.*', placeholder: '' },
  ],
  topUpSources: [
    { id: 'ecocash', name: 'EcoCash' },
    { id: 'onemoney', name: 'OneMoney' },
  ],
  locations: [
    { id: 'zw-eye-hre', kind: 'eye_test', name: 'VID eye test · Harare (Eastlea)', agency: 'VID', capacity: 3, slots: ['08:00', '09:30', '11:00', '14:00'], services: [], counters: 1 },
    { id: 'zw-eye-byo', kind: 'eye_test', name: 'VID eye test · Bulawayo', agency: 'VID', capacity: 2, slots: ['08:30', '10:30', '14:30'], services: [], counters: 1 },
    { id: 'zw-clinic-mbare', kind: 'clinic', name: 'Polyclinic · Mbare', agency: 'MOHCC', capacity: 4, slots: ['08:00', '09:00', '10:00', '14:00'], services: [], counters: 1 },
    { id: 'zw-clinic-highfield', kind: 'clinic', name: 'Polyclinic · Highfield', agency: 'MOHCC', capacity: 4, slots: ['08:00', '09:30', '11:00', '14:30'], services: [], counters: 1 },
    { id: 'zw-clinic-mpilo', kind: 'clinic', name: 'Clinic · Bulawayo', agency: 'MOHCC', capacity: 3, slots: ['08:00', '09:00', '10:30', '14:00'], services: [], counters: 1 },
    { id: 'zw-pp-hre', kind: 'passport', name: 'Passport office · Harare', agency: 'RG', capacity: 3, slots: ['08:00', '09:30', '11:00', '14:00'], services: [], counters: 1 },
    { id: 'zw-pp-byo', kind: 'passport', name: 'Passport office · Bulawayo', agency: 'RG', capacity: 2, slots: ['08:30', '10:30', '14:30'], services: [], counters: 1 },
    { id: 'zw-vid-hre', kind: 'office', name: 'VID · Harare', agency: 'VID', capacity: 1, slots: [], services: ['Licence collection', 'Road test booking'], counters: 4 },
    { id: 'zw-rg-hre', kind: 'office', name: 'Registrar General · Harare', agency: 'RG', capacity: 1, slots: [], services: ['ID replacement', 'Birth registration'], counters: 4 },
    { id: 'zw-zimra-hre', kind: 'office', name: 'ZIMRA · Harare', agency: 'ZIMRA', capacity: 1, slots: [], services: ['Tax returns', 'Tax clearance'], counters: 3 },
    { id: 'zw-council-gweru', kind: 'office', name: 'City council · Gweru', agency: 'COUNCIL', capacity: 1, slots: [], services: ['General enquiry', 'Rates'], counters: 1 },
  ],
  limits: { transferMax: 50000, billMin: 100, airtimeMin: 50, airtimeMax: 5000, topUpMax: 100000, demoCredit: 25000 },
  chips: { send: [5, 10, 20, 50], bills: [5, 10, 20, 50], airtime: [1, 2, 5, 10], topup: [10, 20, 50, 100] },
  demo: {
    meter: '04127788330',
    people: [
      { id: '63245718K42', first: 'Rudo', last: 'Chikore', dob: '1990-08-21', sex: 'F', district: 'Harare', phone: '+263771234558', licenceClass: '4', licenceDays: 30, taxCompliant: true, pin: '2580' },
      { id: '08315920P27', first: 'Tendai', last: 'Moyo', dob: '1986-03-07', sex: 'M', district: 'Harare', phone: '+263712345614', licenceClass: null, licenceDays: null, taxCompliant: true, pin: '1357' },
      { id: '29401236Q63', first: 'Farai', last: 'Ncube', dob: '1994-12-01', sex: 'M', district: 'Bulawayo', phone: '+263773456630', licenceClass: '4', licenceDays: 900, taxCompliant: true, pin: '2468' },
      { id: '63118374H50', first: 'Chipo', last: 'Mutasa', dob: '1966-06-16', sex: 'F', district: 'Mutare', phone: '+263734567702', licenceClass: null, licenceDays: null, taxCompliant: true, pin: '1470' },
      { id: '75226481T13', first: 'Tatenda', last: 'Gumbo', dob: '2002-04-04', sex: 'F', district: 'Harare', phone: '+263775567811', licenceClass: '4', licenceDays: 400, taxCompliant: false },
      { id: '42509137F07', first: 'Blessing', last: 'Sibanda', dob: '1983-09-28', sex: 'M', district: 'Gweru', phone: '+263716678922', licenceClass: '2', licenceDays: 1200, taxCompliant: true },
    ],
    officers: [
      { username: 'vid.case', name: 'Nyasha Marufu', agency: 'VID', role: 'caseworker' },
      { username: 'rg.case', name: 'Simbarashe Dube', agency: 'RG', role: 'caseworker' },
      { username: 'zimra.case', name: 'Ruvimbo Chari', agency: 'ZIMRA', role: 'caseworker' },
      { username: 'vid.counter', name: 'Tapiwa Nyoni', agency: 'VID', role: 'counter' },
      { username: 'admin', name: 'Kgotla Operations', agency: 'KGOTLA', role: 'admin' },
    ],
  },
};
