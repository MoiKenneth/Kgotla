/**
 * Official portals Kgotla points citizens to, per country. Each starts as
 * "linked" (Kgotla opens the institution's own site) and moves to
 * "connecting" and then "connected" as the institution joins through the
 * partner hub or a government data link. Kgotla admins add and edit entries
 * in the officer console; these are only the starting set.
 */
import type { CountryPack } from './types.js';

export type Sector = 'government' | 'tax' | 'banking' | 'health' | 'insurance' | 'utilities' | 'telecoms' | 'education' | 'tourism' | 'transport' | 'other';
export interface DirectorySeed { name: string; sector: Sector; url: string; description: string }

export const COUNTRY_DIRECTORY: Record<CountryPack['code'], DirectorySeed[]> = {
  BW: [
    { name: 'BURS e-Tax', sector: 'tax', url: 'https://eservices.burs.org.bw/burs-etax/home', description: 'File returns, reconcile payments, keep your taxpayer profile up to date, and check tax clearance certificates.' },
    { name: 'FNB Botswana', sector: 'banking', url: 'https://www.fnbbotswana.co.bw/', description: 'Online banking, eWallet, payments, statements and account confirmation letters.' },
    { name: 'Life Gaborone Private Hospital', sector: 'health', url: 'https://www.lifehealthcare.co.za/hospitals/botswana/gaborone/life-gaborone-private-hospital/', description: 'Specialists, emergency unit, maternity, oncology, radiology and online payment of hospital accounts. Segoditshane Road, Gaborone · +267 368 5600.' },
    { name: 'Botswana Power Corporation', sector: 'utilities', url: 'https://www.bpc.bw/', description: 'Electricity accounts, prepaid, outages and new connections.' },
    { name: 'Water Utilities Corporation', sector: 'utilities', url: 'https://www.wuc.bw/', description: 'Water accounts, connections and service notices.' },
    { name: 'Botswana Tourism', sector: 'tourism', url: 'https://www.botswanatourism.co.bw/', description: 'Where to go, where to stay and what to see in Botswana.' },
  ],
  ZA: [
    { name: 'SARS eFiling', sector: 'tax', url: 'https://www.sarsefiling.co.za/', description: 'File and pay tax, and get tax compliance status.' },
    { name: 'SANParks', sector: 'tourism', url: 'https://www.sanparks.org/', description: 'South African National Parks: park information and bookings.' },
  ],
  NA: [
    { name: 'Namibia Revenue Agency (NamRA)', sector: 'tax', url: 'https://www.namra.org.na/', description: 'Tax registration, returns and payments.' },
  ],
  ZM: [
    { name: 'Zambia Revenue Authority', sector: 'tax', url: 'https://www.zra.org.zm/', description: 'Tax registration, returns and payments.' },
  ],
  ZW: [
    { name: 'ZIMRA', sector: 'tax', url: 'https://www.zimra.co.zw/', description: 'Zimbabwe Revenue Authority: tax registration, returns and payments.' },
    { name: 'ZimParks', sector: 'tourism', url: 'https://www.zimparks.org.zw/', description: 'Zimbabwe Parks and Wildlife Management Authority: parks and bookings.' },
  ],
};
