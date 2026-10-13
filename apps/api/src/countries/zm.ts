import { digits, licenceSteps, type CountryPack } from './types.js';

/** Zambia: Phase 2 cell. Fees are demo values. */
export const ZM: CountryPack = {
  code: 'ZM',
  name: 'Zambia',
  possessive: "Zambia's",
  phase: 2,
  currency: { code: 'ZMW', symbol: 'K', minorName: 'ngwee' },
  utcOffset: '+02:00',
  languages: [{ code: 'en', name: 'English' }],
  plannedLanguages: ['Bemba', 'Nyanja', 'Tonga', 'Lozi'],
  nationalId: {
    name: 'NRC number',
    short: 'NRC',
    documentTitle: 'National Registration Card (NRC)',
    example: '234561/11/1',
    inputMode: 'text',
    maxLength: 13,
    error: 'An NRC number looks like 123456/78/1 (9 digits)',
    hashPrefix: 'zm-nrc:',
    // NRC: 6-digit serial / 2-digit district / 1 digit. Stored as 123456/78/1.
    normalise: (raw) => {
      const d = digits(raw);
      return /^\d{9}$/.test(d) ? `${d.slice(0, 6)}/${d.slice(6, 8)}/${d.slice(8)}` : null;
    },
    display: (id) => id,
  },
  phone: { cc: '260', nsn: 9, trunk: true, example: '097 123 4567' },
  ussdCode: '*321#',
  agencies: {
    licence: { code: 'RTSA', name: 'Road Transport and Safety Agency' },
    civil: { code: 'DNRPC', name: 'Department of National Registration, Passport and Citizenship' },
    tax: { code: 'ZRA', name: 'Zambia Revenue Authority' },
    immigration: { code: 'DNRPC', name: 'Department of National Registration, Passport and Citizenship' },
    health: { code: 'MOH', name: 'Ministry of Health' },
    exams: { code: 'ECZ', name: 'Examinations Council of Zambia' },
  },
  licence: { classWord: 'Class', collectAt: 'RTSA · Lusaka' },
  services: [
    {
      code: 'driver_licence_renewal',
      name: "Driver's licence renewal",
      agency: 'RTSA',
      fee: 35000,
      steps: licenceSteps('RTSA'),
      output: { type: 'driver_licence', title: "Driver's licence · Class {licence_class}", issuer: 'RTSA', validYears: 5 },
    },
    {
      code: 'birth_certificate_copy',
      name: 'Birth certificate copy',
      agency: 'DNRPC',
      fee: 5000,
      steps: [
        { key: 'submitted', label: 'Submitted' },
        { key: 'processing', label: 'Being processed by National Registration' },
        { key: 'issued', label: 'Copy issued to your Vault' },
      ],
      output: { type: 'birth_certificate', title: 'Birth certificate · {name}', issuer: 'DNRPC' },
    },
    {
      code: 'tax_clearance',
      name: 'Tax clearance certificate',
      agency: 'ZRA',
      fee: 0,
      steps: [{ key: 'issued', label: 'Certificate issued to your Vault' }],
      output: { type: 'tax_clearance', title: 'Tax clearance certificate (ZRA)', issuer: 'ZRA', validDays: 90 },
    },
  ],
  billers: [
    { id: 'zesco', name: 'ZESCO prepaid electricity', short: 'ZESCO', category: 'electricity', refLabel: 'Meter number', refPattern: '^\\d{11,13}$', placeholder: '0412 7788 3301' },
    { id: 'lwsc', name: 'Lusaka Water Supply and Sanitation', short: 'LWSC', category: 'water', refLabel: 'Account number', refPattern: '^\\d{6,12}$', placeholder: '1093847' },
    { id: 'mtn', name: 'MTN', short: 'MTN', category: 'airtime', refLabel: 'Phone number', refPattern: '.*', placeholder: '' },
    { id: 'airtel', name: 'Airtel', short: 'Airtel', category: 'airtime', refLabel: 'Phone number', refPattern: '.*', placeholder: '' },
    { id: 'zamtel', name: 'Zamtel', short: 'Zamtel', category: 'airtime', refLabel: 'Phone number', refPattern: '.*', placeholder: '' },
  ],
  topUpSources: [
    { id: 'mtn_momo', name: 'MTN MoMo' },
    { id: 'airtel_money', name: 'Airtel Money' },
  ],
  locations: [
    { id: 'zm-eye-lsk', kind: 'eye_test', name: 'RTSA eye test · Lusaka', agency: 'RTSA', capacity: 3, slots: ['08:00', '09:30', '11:00', '14:00'], services: [], counters: 1 },
    { id: 'zm-eye-ndola', kind: 'eye_test', name: 'RTSA eye test · Ndola', agency: 'RTSA', capacity: 2, slots: ['08:30', '10:30', '14:30'], services: [], counters: 1 },
    { id: 'zm-clinic-chawama', kind: 'clinic', name: 'Clinic · Chawama', agency: 'MOH', capacity: 4, slots: ['08:00', '09:00', '10:00', '14:00'], services: [], counters: 1 },
    { id: 'zm-clinic-kanyama', kind: 'clinic', name: 'Clinic · Kanyama', agency: 'MOH', capacity: 4, slots: ['08:00', '09:30', '11:00', '14:30'], services: [], counters: 1 },
    { id: 'zm-clinic-matero', kind: 'clinic', name: 'Clinic · Matero', agency: 'MOH', capacity: 3, slots: ['08:00', '09:00', '10:30', '14:00'], services: [], counters: 1 },
    { id: 'zm-pp-lsk', kind: 'passport', name: 'Passport office · Lusaka', agency: 'DNRPC', capacity: 3, slots: ['08:00', '09:30', '11:00', '14:00'], services: [], counters: 1 },
    { id: 'zm-pp-ndola', kind: 'passport', name: 'Passport office · Ndola', agency: 'DNRPC', capacity: 2, slots: ['08:30', '10:30', '14:30'], services: [], counters: 1 },
    { id: 'zm-rtsa-lsk', kind: 'office', name: 'RTSA · Lusaka', agency: 'RTSA', capacity: 1, slots: [], services: ['Licence collection', 'Road tax'], counters: 4 },
    { id: 'zm-nrc-lsk', kind: 'office', name: 'National Registration · Lusaka', agency: 'DNRPC', capacity: 1, slots: [], services: ['NRC replacement', 'Birth registration'], counters: 4 },
    { id: 'zm-zra-lsk', kind: 'office', name: 'ZRA · Lusaka', agency: 'ZRA', capacity: 1, slots: [], services: ['Tax returns', 'TPIN registration'], counters: 3 },
    { id: 'zm-council-kitwe', kind: 'office', name: 'City council · Kitwe', agency: 'COUNCIL', capacity: 1, slots: [], services: ['General enquiry', 'Rates'], counters: 1 },
  ],
  limits: { transferMax: 1000000, billMin: 2000, airtimeMin: 500, airtimeMax: 100000, topUpMax: 2000000, demoCredit: 500000 },
  chips: { send: [100, 200, 500, 1000], bills: [100, 250, 500, 1000], airtime: [10, 20, 50, 100], topup: [200, 500, 1000, 2000] },
  demo: {
    meter: '04127788330',
    people: [
      { id: '234561/11/1', first: 'Mutale', last: 'Banda', dob: '1990-02-18', sex: 'F', district: 'Lusaka', phone: '+260971234558', licenceClass: 'B', licenceDays: 30, taxCompliant: true, pin: '2580' },
      { id: '345672/10/1', first: 'Chanda', last: 'Mwila', dob: '1987-10-03', sex: 'M', district: 'Lusaka', phone: '+260962345614', licenceClass: null, licenceDays: null, taxCompliant: true, pin: '1357' },
      { id: '456783/61/1', first: 'Bwalya', last: 'Phiri', dob: '1995-06-22', sex: 'M', district: 'Ndola', phone: '+260973456630', licenceClass: 'B', licenceDays: 900, taxCompliant: true, pin: '2468' },
      { id: '567894/11/1', first: 'Mwape', last: 'Tembo', dob: '1968-04-30', sex: 'F', district: 'Kitwe', phone: '+260954567702', licenceClass: null, licenceDays: null, taxCompliant: true, pin: '1470' },
      { id: '678905/68/1', first: 'Natasha', last: 'Zulu', dob: '2000-11-14', sex: 'F', district: 'Lusaka', phone: '+260965567811', licenceClass: 'B', licenceDays: 400, taxCompliant: false },
      { id: '789016/11/1', first: 'Kelvin', last: 'Mulenga', dob: '1984-01-25', sex: 'M', district: 'Kabwe', phone: '+260976678922', licenceClass: 'C', licenceDays: 1200, taxCompliant: true },
    ],
    officers: [
      { username: 'rtsa.case', name: 'Grace Mwanza', agency: 'RTSA', role: 'caseworker' },
      { username: 'dnrpc.case', name: 'Joseph Sakala', agency: 'DNRPC', role: 'caseworker' },
      { username: 'zra.case', name: 'Mercy Chileshe', agency: 'ZRA', role: 'caseworker' },
      { username: 'rtsa.counter', name: 'Brian Lungu', agency: 'RTSA', role: 'counter' },
      { username: 'admin', name: 'Kgotla Operations', agency: 'KGOTLA', role: 'admin' },
    ],
  },
};
