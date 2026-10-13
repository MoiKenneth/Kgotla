/**
 * Partner types, what each may ask citizens for, the documents each may issue,
 * and per country: which regulator licenses each type, plus demo partners.
 *
 * Regulator names are a starting point for each country's due diligence and
 * must be confirmed before a pilot (docs/PARTNERS.md).
 */
import type { CountryPack } from './types.js';

export const PARTNER_TYPES = ['clinic', 'doctor', 'pharmacy', 'bank', 'mobile_money', 'insurer', 'utility', 'telco', 'school', 'employer', 'hotel', 'tour_operator'] as const;
export type PartnerType = (typeof PARTNER_TYPES)[number];

/** What a citizen can be asked to share or allow. Shown to the citizen word for word. */
export const SCOPES = {
  'identity.basic': { name: 'Your name and the last 4 characters of your ID', short: 'Name' },
  'identity.kyc': { name: 'Your verified identity: full name, date of birth, district, phone number and ID check result', short: 'Verified identity' },
  'documents.read': { name: 'A list of the documents in your Vault (titles, references and expiry dates)', short: 'Vault list' },
  'documents.issue': { name: 'Put documents in your Vault, such as sick notes, prescriptions, results or statements', short: 'Send documents' },
  'payments.request': { name: 'Send you bills to pay. You approve every payment with your PIN', short: 'Send bills' },
  'notifications.send': { name: 'Send you messages and reminders', short: 'Messages' },
} as const;
export type Scope = keyof typeof SCOPES;
export const SCOPE_IDS = Object.keys(SCOPES) as Scope[];

/** Not a citizen consent: the partner manages its own bookable locations (clinics, practices). */
export const LOCATIONS_MANAGE = 'locations.manage';
/** Not a citizen consent: the partner publishes bookable stays or safaris (tourism). */
export const LISTINGS_MANAGE = 'listings.manage';

export const PARTNER_TYPE_INFO: Record<PartnerType, { label: string; capabilities: string[]; documentTypes: string[] }> = {
  clinic: {
    label: 'Clinic or hospital',
    capabilities: ['identity.basic', 'documents.issue', 'payments.request', 'notifications.send', LOCATIONS_MANAGE],
    documentTypes: ['medical_certificate', 'prescription', 'lab_result', 'vaccination_record', 'referral_letter', 'discharge_summary'],
  },
  doctor: {
    label: 'Doctor or private practice',
    capabilities: ['identity.basic', 'documents.issue', 'payments.request', 'notifications.send', LOCATIONS_MANAGE],
    documentTypes: ['medical_certificate', 'prescription', 'lab_result', 'referral_letter'],
  },
  pharmacy: {
    label: 'Pharmacy',
    capabilities: ['identity.basic', 'documents.read', 'payments.request', 'notifications.send'],
    documentTypes: ['dispensing_record'],
  },
  bank: {
    label: 'Bank',
    capabilities: ['identity.basic', 'identity.kyc', 'documents.read', 'documents.issue', 'payments.request', 'notifications.send'],
    documentTypes: ['bank_statement', 'bank_confirmation_letter', 'loan_agreement'],
  },
  mobile_money: {
    label: 'Mobile-money operator',
    capabilities: ['identity.basic', 'identity.kyc', 'payments.request', 'notifications.send'],
    documentTypes: ['wallet_statement'],
  },
  insurer: {
    label: 'Insurer or medical aid',
    capabilities: ['identity.basic', 'identity.kyc', 'documents.read', 'documents.issue', 'payments.request', 'notifications.send'],
    documentTypes: ['insurance_policy', 'medical_aid_card', 'claim_statement'],
  },
  utility: {
    label: 'Utility (power, water)',
    capabilities: ['identity.basic', 'documents.issue', 'payments.request', 'notifications.send'],
    documentTypes: ['utility_statement', 'connection_certificate'],
  },
  telco: {
    label: 'Mobile network or internet provider',
    capabilities: ['identity.basic', 'identity.kyc', 'documents.issue', 'payments.request', 'notifications.send'],
    documentTypes: ['sim_registration', 'account_statement'],
  },
  school: {
    label: 'School, college or university',
    capabilities: ['identity.basic', 'documents.issue', 'payments.request', 'notifications.send'],
    documentTypes: ['school_report', 'certificate', 'enrolment_letter', 'transcript'],
  },
  employer: {
    label: 'Employer',
    capabilities: ['identity.basic', 'identity.kyc', 'documents.issue', 'notifications.send'],
    documentTypes: ['payslip', 'employment_letter', 'tax_certificate_employee'],
  },
  hotel: {
    label: 'Hotel, lodge, guesthouse or camp',
    capabilities: ['identity.basic', 'documents.issue', 'payments.request', 'notifications.send', LISTINGS_MANAGE],
    documentTypes: ['booking_confirmation', 'invoice'],
  },
  tour_operator: {
    label: 'Safari or tour operator',
    capabilities: ['identity.basic', 'documents.issue', 'payments.request', 'notifications.send', LISTINGS_MANAGE],
    documentTypes: ['booking_confirmation', 'invoice'],
  },
};

interface Regulator { code: string; name: string }
interface DemoPartner { code: string; type: PartnerType; tradingName: string; legalName: string; registrationNo: string; licenceNo: string; contactName: string; email: string; phone: string; status: 'approved' | 'applied' }

export interface CountryPartners {
  companyRegistry: Regulator;
  regulators: Record<PartnerType, Regulator>;
  demo: DemoPartner[];
}

const R = (code: string, name: string): Regulator => ({ code, name });

export const COUNTRY_PARTNERS: Record<CountryPack['code'], CountryPartners> = {
  BW: {
    companyRegistry: R('CIPA', 'Companies and Intellectual Property Authority'),
    regulators: {
      clinic: R('MOH', 'Ministry of Health (health facility licence)'),
      doctor: R('BHPC', 'Botswana Health Professions Council'),
      pharmacy: R('BoMRA', 'Botswana Medicines Regulatory Authority'),
      bank: R('BoB', 'Bank of Botswana'),
      mobile_money: R('BoB', 'Bank of Botswana (e-money)'),
      insurer: R('NBFIRA', 'Non-Bank Financial Institutions Regulatory Authority'),
      utility: R('BERA', 'Botswana Energy Regulatory Authority'),
      telco: R('BOCRA', 'Botswana Communications Regulatory Authority'),
      school: R('MoESD', 'Ministry of Education and Skills Development'),
      employer: R('CIPA', 'Companies and Intellectual Property Authority'),
      hotel: R('DoT', 'Department of Tourism (tourism enterprise licence) / Botswana Tourism Organisation grading'),
      tour_operator: R('DoT', 'Department of Tourism (tourism enterprise licence)'),
    },
    demo: [
      { code: 'thusong-clinic', type: 'clinic', tradingName: 'Thusong Family Clinic', legalName: 'Thusong Family Clinic (Pty) Ltd', registrationNo: 'BW00001234567', licenceNo: 'HF-2041', contactName: 'Sister Kelebogile Moeng', email: 'clinic@demo.kgotla', phone: '+26773100200', status: 'approved' },
      { code: 'kopano-bank', type: 'bank', tradingName: 'Kopano Savings Bank', legalName: 'Kopano Savings Bank Limited', registrationNo: 'BW00007654321', licenceNo: 'BL-019', contactName: 'Onalenna Sebina', email: 'bank@demo.kgotla', phone: '+26773100300', status: 'approved' },
      { code: 'dr-kgari', type: 'doctor', tradingName: 'Dr Boitumelo Kgari', legalName: 'Kgari Medical Practice', registrationNo: 'BW00005550123', licenceNo: 'BHPC-MP-08812', contactName: 'Dr Boitumelo Kgari', email: 'doctor@demo.kgotla', phone: '+26773100400', status: 'applied' },
      { code: 'letsatsi-lodge', type: 'hotel', tradingName: 'Letsatsi River Lodge', legalName: 'Letsatsi River Lodge (Pty) Ltd', registrationNo: 'BW00003334445', licenceNo: 'TEL-0911', contactName: 'Kefilwe Ntshole', email: 'hotel@demo.kgotla', phone: '+26773100500', status: 'approved' },
      { code: 'tsodilo-trails', type: 'tour_operator', tradingName: 'Tsodilo Trails Safaris', legalName: 'Tsodilo Trails Safaris (Pty) Ltd', registrationNo: 'BW00004445556', licenceNo: 'TOL-0478', contactName: 'Mpho Ditshwanelo', email: 'safari@demo.kgotla', phone: '+26773100600', status: 'approved' },
    ],
  },
  ZA: {
    companyRegistry: R('CIPC', 'Companies and Intellectual Property Commission'),
    regulators: {
      clinic: R('OHSC', 'Office of Health Standards Compliance / provincial Department of Health'),
      doctor: R('HPCSA', 'Health Professions Council of South Africa'),
      pharmacy: R('SAPC', 'South African Pharmacy Council'),
      bank: R('PA', 'Prudential Authority (South African Reserve Bank)'),
      mobile_money: R('SARB', 'South African Reserve Bank'),
      insurer: R('PA', 'Prudential Authority and Financial Sector Conduct Authority'),
      utility: R('NERSA', 'National Energy Regulator of South Africa'),
      telco: R('ICASA', 'Independent Communications Authority of South Africa'),
      school: R('DBE', 'Department of Basic Education / Department of Higher Education and Training'),
      employer: R('CIPC', 'Companies and Intellectual Property Commission'),
      hotel: R('TGCSA', 'Tourism Grading Council of South Africa / municipal business licence'),
      tour_operator: R('NDT', 'National Department of Tourism (tourist guide registration)'),
    },
    demo: [
      { code: 'ubuntu-clinic', type: 'clinic', tradingName: 'Ubuntu Family Clinic', legalName: 'Ubuntu Family Clinic (Pty) Ltd', registrationNo: '2019/123456/07', licenceNo: 'GP-HF-7781', contactName: 'Sister Zanele Mthembu', email: 'clinic@demo.kgotla', phone: '+27821000200', status: 'approved' },
      { code: 'indlovu-bank', type: 'bank', tradingName: 'Indlovu Community Bank', legalName: 'Indlovu Community Bank Limited', registrationNo: '2015/765432/06', licenceNo: 'PA-BL-0451', contactName: 'Kagiso Mahlangu', email: 'bank@demo.kgotla', phone: '+27821000300', status: 'approved' },
      { code: 'dr-khumalo', type: 'doctor', tradingName: 'Dr Lerato Khumalo', legalName: 'Khumalo Medical Practice', registrationNo: '2021/555012/07', licenceNo: 'MP0661234', contactName: 'Dr Lerato Khumalo', email: 'doctor@demo.kgotla', phone: '+27821000400', status: 'applied' },
      { code: 'nyala-bend', type: 'hotel', tradingName: 'Nyala Bend Lodge', legalName: 'Nyala Bend Lodge (Pty) Ltd', registrationNo: '2016/221144/07', licenceNo: 'TGCSA-30412', contactName: 'Thuli Ndlovu', email: 'hotel@demo.kgotla', phone: '+27821000500', status: 'approved' },
      { code: 'marula-path', type: 'tour_operator', tradingName: 'Marula Path Safaris', legalName: 'Marula Path Safaris (Pty) Ltd', registrationNo: '2017/331155/07', licenceNo: 'TG-GP-11823', contactName: 'Andile Zungu', email: 'safari@demo.kgotla', phone: '+27821000600', status: 'approved' },
    ],
  },
  NA: {
    companyRegistry: R('BIPA', 'Business and Intellectual Property Authority'),
    regulators: {
      clinic: R('MHSS', 'Ministry of Health and Social Services'),
      doctor: R('HPCNA', 'Health Professions Councils of Namibia'),
      pharmacy: R('PCN', 'Pharmacy Council of Namibia'),
      bank: R('BoN', 'Bank of Namibia'),
      mobile_money: R('BoN', 'Bank of Namibia (e-money)'),
      insurer: R('NAMFISA', 'Namibia Financial Institutions Supervisory Authority'),
      utility: R('ECB', 'Electricity Control Board'),
      telco: R('CRAN', 'Communications Regulatory Authority of Namibia'),
      school: R('MoEAC', 'Ministry of Education, Arts and Culture'),
      employer: R('BIPA', 'Business and Intellectual Property Authority'),
      hotel: R('NTB', 'Namibia Tourism Board (registration of accommodation)'),
      tour_operator: R('NTB', 'Namibia Tourism Board (registration of tour operators)'),
    },
    demo: [
      { code: 'omusati-clinic', type: 'clinic', tradingName: 'Omusati Family Clinic', legalName: 'Omusati Family Clinic (Pty) Ltd', registrationNo: '2018/0456', licenceNo: 'MHSS-HF-332', contactName: 'Sister Ndinelao Shilongo', email: 'clinic@demo.kgotla', phone: '+264811000200', status: 'approved' },
      { code: 'ondjila-bank', type: 'bank', tradingName: 'Ondjila Savings Bank', legalName: 'Ondjila Savings Bank Limited', registrationNo: '2012/0789', licenceNo: 'BoN-BL-12', contactName: 'Frieda Nghipondoka', email: 'bank@demo.kgotla', phone: '+264811000300', status: 'approved' },
      { code: 'dr-haufiku', type: 'doctor', tradingName: 'Dr Martha Haufiku', legalName: 'Haufiku Medical Practice', registrationNo: '2022/1101', licenceNo: 'MP-4410', contactName: 'Dr Martha Haufiku', email: 'doctor@demo.kgotla', phone: '+264811000400', status: 'applied' },
      { code: 'okondeka-lodge', type: 'hotel', tradingName: 'Okondeka Plains Lodge', legalName: 'Okondeka Plains Lodge (Pty) Ltd', registrationNo: '2015/0911', licenceNo: 'NTB-AC-2231', contactName: 'Ester Amukoto', email: 'hotel@demo.kgotla', phone: '+264811000500', status: 'approved' },
      { code: 'red-dune-trails', type: 'tour_operator', tradingName: 'Red Dune Trails', legalName: 'Red Dune Trails CC', registrationNo: 'CC/2014/1120', licenceNo: 'NTB-TO-0877', contactName: 'Johannes Kamati', email: 'safari@demo.kgotla', phone: '+264811000600', status: 'approved' },
    ],
  },
  ZM: {
    companyRegistry: R('PACRA', 'Patents and Companies Registration Agency'),
    regulators: {
      clinic: R('HPCZ', 'Health Professions Council of Zambia (facility licence)'),
      doctor: R('HPCZ', 'Health Professions Council of Zambia'),
      pharmacy: R('ZAMRA', 'Zambia Medicines Regulatory Authority'),
      bank: R('BoZ', 'Bank of Zambia'),
      mobile_money: R('BoZ', 'Bank of Zambia (payment systems)'),
      insurer: R('PIA', 'Pensions and Insurance Authority'),
      utility: R('ERB', 'Energy Regulation Board'),
      telco: R('ZICTA', 'Zambia Information and Communications Technology Authority'),
      school: R('MoE', 'Ministry of Education'),
      employer: R('PACRA', 'Patents and Companies Registration Agency'),
      hotel: R('MoT', 'Ministry of Tourism (tourism enterprise licence)'),
      tour_operator: R('MoT', 'Ministry of Tourism (tourism enterprise licence)'),
    },
    demo: [
      { code: 'kabulonga-clinic', type: 'clinic', tradingName: 'Kabulonga Family Clinic', legalName: 'Kabulonga Family Clinic Limited', registrationNo: '120190012345', licenceNo: 'HPCZ-HF-2290', contactName: 'Sister Mwila Chanda', email: 'clinic@demo.kgotla', phone: '+260971000200', status: 'approved' },
      { code: 'mwezi-bank', type: 'bank', tradingName: 'Mwezi Community Bank', legalName: 'Mwezi Community Bank Limited', registrationNo: '120140067890', licenceNo: 'BoZ-BL-031', contactName: 'Chipo Lungu', email: 'bank@demo.kgotla', phone: '+260971000300', status: 'approved' },
      { code: 'dr-mwansa', type: 'doctor', tradingName: 'Dr Chileshe Mwansa', legalName: 'Mwansa Medical Practice', registrationNo: '120220011122', licenceNo: 'HPCZ-MP-7735', contactName: 'Dr Chileshe Mwansa', email: 'doctor@demo.kgotla', phone: '+260971000400', status: 'applied' },
      { code: 'nsefu-bend', type: 'hotel', tradingName: 'Nsefu Bend Camp', legalName: 'Nsefu Bend Camp Limited', registrationNo: '120160033221', licenceNo: 'MoT-TEL-1452', contactName: 'Mutinta Hamoonga', email: 'hotel@demo.kgotla', phone: '+260971000500', status: 'approved' },
      { code: 'kafue-canoe', type: 'tour_operator', tradingName: 'Kafue Canoe Trails', legalName: 'Kafue Canoe Trails Limited', registrationNo: '120170044332', licenceNo: 'MoT-TEL-1688', contactName: 'Bupe Kasonde', email: 'safari@demo.kgotla', phone: '+260971000600', status: 'approved' },
    ],
  },
  ZW: {
    companyRegistry: R('CR', 'Companies and Other Business Entities Registry'),
    regulators: {
      clinic: R('MoHCC', 'Ministry of Health and Child Care (health facility registration)'),
      doctor: R('MDPCZ', 'Medical and Dental Practitioners Council of Zimbabwe'),
      pharmacy: R('MCAZ', 'Medicines Control Authority of Zimbabwe'),
      bank: R('RBZ', 'Reserve Bank of Zimbabwe'),
      mobile_money: R('RBZ', 'Reserve Bank of Zimbabwe (payment systems)'),
      insurer: R('IPEC', 'Insurance and Pensions Commission'),
      utility: R('ZERA', 'Zimbabwe Energy Regulatory Authority'),
      telco: R('POTRAZ', 'Postal and Telecommunications Regulatory Authority of Zimbabwe'),
      school: R('MoPSE', 'Ministry of Primary and Secondary Education / Ministry of Higher Education'),
      employer: R('CR', 'Companies and Other Business Entities Registry'),
      hotel: R('ZTA', 'Zimbabwe Tourism Authority (registration and licensing)'),
      tour_operator: R('ZTA', 'Zimbabwe Tourism Authority (registration and licensing)'),
    },
    demo: [
      { code: 'avondale-clinic', type: 'clinic', tradingName: 'Avondale Family Clinic', legalName: 'Avondale Family Clinic (Private) Limited', registrationNo: '4521/2017', licenceNo: 'MoHCC-HF-118', contactName: 'Sister Nyasha Mapfumo', email: 'clinic@demo.kgotla', phone: '+263771000200', status: 'approved' },
      { code: 'musha-bank', type: 'bank', tradingName: 'Musha Savings Bank', legalName: 'Musha Savings Bank Limited', registrationNo: '1209/2011', licenceNo: 'RBZ-BL-22', contactName: 'Tinashe Murwira', email: 'bank@demo.kgotla', phone: '+263771000300', status: 'approved' },
      { code: 'dr-moyo', type: 'doctor', tradingName: 'Dr Tafadzwa Moyo', legalName: 'Moyo Medical Practice', registrationNo: '3310/2022', licenceNo: 'MDPCZ-6623', contactName: 'Dr Tafadzwa Moyo', email: 'doctor@demo.kgotla', phone: '+263771000400', status: 'applied' },
      { code: 'mosi-gorge', type: 'hotel', tradingName: 'Mosi Gorge Lodge', legalName: 'Mosi Gorge Lodge (Private) Limited', registrationNo: '2210/2016', licenceNo: 'ZTA-AC-3302', contactName: 'Rumbidzai Chari', email: 'hotel@demo.kgotla', phone: '+263771000500', status: 'approved' },
      { code: 'spray-mist', type: 'tour_operator', tradingName: 'Spray Mist Tours', legalName: 'Spray Mist Tours (Private) Limited', registrationNo: '3341/2018', licenceNo: 'ZTA-TO-1190', contactName: 'Tatenda Banda', email: 'safari@demo.kgotla', phone: '+263771000600', status: 'approved' },
    ],
  },
};
