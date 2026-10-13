/**
 * Tourism per country: the parks agency, national parks with entry rates,
 * and demo stays and safaris for the demo hotel and tour operator.
 *
 * Park names are real places. Every price here is a DEMO figure in the local
 * currency: confirm entry fees with each parks agency before a pilot
 * (docs/TOURISM.md).
 */
import type { CountryPack } from './types.js';

export interface Rate { key: string; label: string; price: number } // minor units per unit
export interface ListingSeed {
  key: string;
  kind: 'stay' | 'safari' | 'park' | 'reserve' | 'driver';
  /** Stays: lodge, hotel, camp, guesthouse. Drivers: transfer, driver_guide. */
  category?: string;
  name: string;
  region: string;
  description: string;
  highlights: string[];
  unit: 'room_night' | 'person' | 'person_day' | 'vehicle_day' | 'trip';
  rates: Rate[];
  capacity: number;
  durationDays?: number;
  cancelHours: number;
}

interface CountryTourism {
  parksAgency: { code: string; name: string };
  parks: ListingSeed[];
  /** Listings for the demo hotel and tour operator, keyed by partner code. */
  demoListings: Record<string, ListingSeed[]>;
}

/** Park entry: citizen / regional / international, per person per day. */
const parkRates = (citizen: number, sadc: number, intl: number, citizenLabel: string): Rate[] => [
  { key: 'citizen', label: citizenLabel, price: citizen },
  { key: 'sadc', label: 'SADC resident', price: sadc },
  { key: 'international', label: 'International visitor', price: intl },
];
const park = (key: string, name: string, region: string, description: string, highlights: string[], rates: Rate[], capacity = 150): ListingSeed => ({
  key, kind: 'park', name, region, description, highlights, unit: 'person_day', rates, capacity, cancelHours: 24,
});
const stay = (key: string, name: string, region: string, description: string, highlights: string[], standard: number, family: number, rooms = 8, category = 'lodge'): ListingSeed => ({
  key, kind: 'stay', category, name, region, description, highlights, unit: 'room_night', capacity: rooms, cancelHours: 72,
  rates: [{ key: 'standard', label: 'Standard room (2 people, breakfast)', price: standard }, { key: 'family', label: 'Family room (4 people, breakfast)', price: family }],
});
const safari = (key: string, name: string, region: string, description: string, highlights: string[], adult: number, child: number, days: number, seats = 12): ListingSeed => ({
  key, kind: 'safari', name, region, description, highlights, unit: 'person', capacity: seats, durationDays: days, cancelHours: 72,
  rates: [{ key: 'adult', label: 'Adult', price: adult }, { key: 'child', label: 'Child (under 12)', price: child }],
});

/** Prices are written in pula; each cell converts them to its own currency (demo figures only). */
const FX: Record<string, number> = { BW: 1, ZA: 1.35, NA: 1.35, ZM: 1.9, ZW: 0.074 };
const px = (cc: string, pula: number) => (cc === 'ZW' ? Math.max(100, Math.round((pula * FX[cc]) / 100) * 100) : Math.round((pula * FX[cc]) / 1000) * 1000);

/** A private game reserve: day entry (citizen / SADC / international) and a guided game drive. */
const reserveListings = (cc: string, name: string, region: string, blurb: string, highlights: string[]): ListingSeed[] => [
  { key: 'day-visit', kind: 'reserve', name, region, description: blurb, highlights, unit: 'person_day', capacity: 80, cancelHours: 24,
    rates: [{ key: 'citizen', label: 'Citizen', price: px(cc, 5000) }, { key: 'sadc', label: 'SADC resident', price: px(cc, 10000) }, { key: 'international', label: 'International visitor', price: px(cc, 25000) }] },
  { key: 'game-drive', kind: 'reserve', name: `${name} · guided game drive`, region, description: 'Three hours in an open vehicle with a ranger, morning or late afternoon. Entry included.', highlights: ['Ranger-guided', 'Entry included', 'Binoculars provided'],
    unit: 'person', capacity: 18, cancelHours: 24, rates: [{ key: 'adult', label: 'Adult', price: px(cc, 35000) }, { key: 'child', label: 'Child (under 12)', price: px(cc, 17500) }] },
];

/** A transport company: airport transfers (per vehicle per trip) and a driver-guide with vehicle (per day). */
const driverListings = (cc: string, airport: string, region: string, guideRegion: string): ListingSeed[] => [
  { key: 'airport-transfer', kind: 'driver', category: 'transfer', name: `${airport} airport transfer`, region, description: 'Meet-and-greet at arrivals and a direct drive to your lodge, hotel or home. Price per vehicle, one way.', highlights: ['Flight tracking', 'Licensed driver', 'Child seats on request'],
    unit: 'trip', capacity: 6, cancelHours: 12, rates: [{ key: 'sedan', label: 'Sedan (up to 3 people)', price: px(cc, 35000) }, { key: 'minibus', label: 'Minibus (up to 10 people)', price: px(cc, 60000) }] },
  { key: 'driver-guide', kind: 'driver', category: 'driver_guide', name: 'Driver-guide with 4x4', region: guideRegion, description: 'A licensed driver-guide and a 4x4 for the day: park self-drives without the stress, town tours or long-distance trips. Fuel included up to 300 km.', highlights: ['Licensed guide', 'Fuel included', 'Up to 6 people'],
    unit: 'vehicle_day', capacity: 4, cancelHours: 48, rates: [{ key: '4x4', label: '4x4 with driver-guide', price: px(cc, 250000) }, { key: 'sedan', label: 'Sedan with driver', price: px(cc, 120000) }] },
];

export const COUNTRY_TOURISM: Record<CountryPack['code'], CountryTourism> = {
  BW: {
    parksAgency: { code: 'DWNP', name: 'Department of Wildlife and National Parks' },
    parks: [
      park('chobe', 'Chobe National Park', 'Chobe · Kasane', 'Riverfront game drives and boat cruises among some of Africa’s largest elephant herds.', ['Chobe riverfront', 'Elephants and buffalo', 'Sedudu gate near Kasane'], parkRates(1000, 3000, 12000, 'Motswana citizen')),
      park('moremi', 'Moremi Game Reserve', 'Okavango Delta · Maun', 'The wild heart of the Okavango Delta: lagoons, floodplains and big cats.', ['Third Bridge and Xakanaxa', 'Mokoro and game drives', 'South Gate from Maun'], parkRates(1000, 3000, 12000, 'Motswana citizen')),
      park('ckgr', 'Central Kalahari Game Reserve', 'Ghanzi · Kalahari', 'Vast desert reserve with fossil river valleys, black-maned lions and starry skies.', ['Deception Valley', 'Self-drive 4x4 only', 'Matswere gate'], parkRates(1000, 3000, 12000, 'Motswana citizen'), 40),
    ],
    demoListings: {
      'tshwene-reserve': reserveListings('BW', 'Tshwene Wildlife Reserve', 'Gaborone', 'Bushveld reserve 20 minutes from Gaborone with giraffe, zebra, rhino and walking trails.', ['20 min from Gaborone', 'Rhino and giraffe', 'Walking trails']),
      'motse-drive': driverListings('BW', 'Sir Seretse Khama (Gaborone)', 'Gaborone', 'Okavango Delta · Maun'),
      'letsatsi-lodge': [
        stay('river-rooms', 'Letsatsi River Lodge', 'Okavango Delta · Maun', 'Riverside lodge on the Thamalakane River, ten minutes from Maun airport.', ['Pool and river deck', 'Airport transfers', 'Mokoro trips arranged'], 145000, 230000),
        stay('gaborone', 'Letsatsi Garden Guesthouse', 'Gaborone', 'Quiet guesthouse near the CBD and Government Enclave, for work trips and family visits.', ['Wi-Fi and workspace', 'Secure parking', 'Near Main Mall'], 85000, 130000, 10, 'guesthouse'),
      ],
      'tsodilo-trails': [
        safari('mokoro-day', 'Okavango mokoro day trip', 'Okavango Delta · Maun', 'Glide through the Delta channels in a traditional mokoro with a licensed poler-guide, with a bush walk and lunch.', ['Pick-up in Maun', 'Licensed guide', 'Lunch included'], 65000, 32500, 1),
        safari('chobe-3day', 'Chobe 3-day camping safari', 'Chobe · Kasane', 'Three days of game drives and a sunset river cruise, camping at a private site inside the park.', ['Park fees included', 'All meals', 'Small group'], 680000, 340000, 3, 8),
      ],
    },
  },
  ZA: {
    parksAgency: { code: 'SANParks', name: 'South African National Parks' },
    parks: [
      park('kruger', 'Kruger National Park', 'Mpumalanga · Limpopo', 'Classic big-five country with a network of rest camps and tarred and gravel game roads.', ['Big five', 'Self-drive or guided', 'Many entry gates'], parkRates(13000, 26000, 52000, 'SA citizen or resident')),
      park('addo', 'Addo Elephant National Park', 'Eastern Cape', 'Dense thicket home to hundreds of elephants, a short drive from Gqeberha.', ['Elephants', 'Malaria free', 'Main camp gate'], parkRates(8000, 16000, 32000, 'SA citizen or resident')),
      park('kgalagadi', 'Kgalagadi Transfrontier Park', 'Northern Cape', 'Red dunes and dry riverbeds shared with Botswana, famous for black-maned lions.', ['Twee Rivieren gate', 'Cross-border park', 'Raptors and cheetah'], parkRates(10000, 20000, 46000, 'SA citizen or resident'), 60),
    ],
    demoListings: {
      'inyathi-ridge': reserveListings('ZA', 'Inyathi Ridge Private Reserve', 'Mpumalanga · Limpopo', 'Big-five private reserve bordering Kruger, with open-vehicle drives and bush walks.', ['Big five', 'Borders Kruger', 'Bush walks']),
      'umoya-transfers': driverListings('ZA', 'O.R. Tambo (Johannesburg)', 'Gauteng · Johannesburg', 'Mpumalanga · Limpopo'),
      'nyala-bend': [
        stay('hoedspruit', 'Nyala Bend Lodge', 'Mpumalanga · Limpopo', 'Bush lodge near Kruger’s Orpen gate with a waterhole in front of the rooms.', ['Waterhole views', 'Close to Kruger', 'Braai area'], 185000, 290000),
        stay('cape-town', 'Nyala Bend City Guesthouse', 'Western Cape · Cape Town', 'Guesthouse in the city bowl with views of Table Mountain.', ['Walk to the city centre', 'Rooftop terrace', 'Wi-Fi'], 160000, 250000, 10, 'guesthouse'),
      ],
      'marula-path': [
        safari('kruger-2day', 'Kruger 2-day guided safari', 'Mpumalanga · Limpopo', 'Two days of open-vehicle game drives with a registered field guide, overnight in a rest camp.', ['Park fees included', 'Registered guide', 'Pick-up in Hazyview'], 520000, 260000, 2, 9),
        safari('cape-day', 'Cape Peninsula day tour', 'Western Cape · Cape Town', 'Chapman’s Peak, Cape Point and the penguins at Boulders Beach in one day.', ['Hotel pick-up', 'Entrance fees included', 'Small group'], 145000, 75000, 1),
      ],
    },
  },
  NA: {
    parksAgency: { code: 'MEFT', name: 'Ministry of Environment, Forestry and Tourism (park permits)' },
    parks: [
      park('etosha', 'Etosha National Park', 'Oshana · Kunene', 'A great salt pan ringed by floodlit waterholes where lions, rhinos and elephants come to drink.', ['Okaukuejo waterhole', 'Anderson and Von Lindequist gates', 'Self-drive'], parkRates(3000, 6000, 15000, 'Namibian citizen')),
      park('namib-naukluft', 'Namib-Naukluft Park · Sossusvlei', 'Hardap · Sossusvlei', 'The world’s oldest desert: towering red dunes, Deadvlei and Sesriem Canyon.', ['Sunrise on Dune 45', 'Deadvlei', 'Sesriem gate'], parkRates(3000, 6000, 15000, 'Namibian citizen')),
      park('bwabwata', 'Bwabwata National Park', 'Zambezi', 'Rivers and floodplains of the Zambezi region, with elephants, hippos and birdlife.', ['Kwando River', 'Buffalo core area', 'Community conservancies'], parkRates(2000, 4000, 10000, 'Namibian citizen'), 60),
    ],
    demoListings: {
      'omuramba-reserve': reserveListings('NA', 'Omuramba Private Reserve', 'Khomas · Windhoek', 'Highland reserve near Windhoek with oryx, kudu, cheetah and hiking trails.', ['Near Windhoek', 'Cheetah', 'Hiking trails']),
      'ombepo-transfers': driverListings('NA', 'Hosea Kutako (Windhoek)', 'Khomas · Windhoek', 'Oshana · Kunene'),
      'okondeka-lodge': [
        stay('etosha', 'Okondeka Plains Lodge', 'Oshana · Kunene', 'Lodge ten minutes from Etosha’s Anderson gate, with its own waterhole.', ['Near Anderson gate', 'Pool', 'Dinner available'], 190000, 300000),
        stay('windhoek', 'Okondeka Windhoek Garden House', 'Khomas · Windhoek', 'Garden guesthouse in Klein Windhoek, close to the city and the airport road.', ['Secure parking', 'Garden', 'Wi-Fi'], 110000, 170000, 10, 'guesthouse'),
      ],
      'red-dune-trails': [
        safari('sossusvlei-day', 'Sossusvlei sunrise tour', 'Hardap · Sossusvlei', 'Climb Dune 45 at sunrise and walk to Deadvlei with a desert guide.', ['Park permit included', 'Breakfast in the dunes', 'Sesriem pick-up'], 120000, 60000, 1),
        safari('etosha-3day', 'Etosha 3-day safari', 'Oshana · Kunene', 'Three days of game drives across Etosha, staying at the park’s rest camps.', ['Park fees included', 'All meals', 'Small group'], 690000, 345000, 3, 8),
      ],
    },
  },
  ZM: {
    parksAgency: { code: 'DNPW', name: 'Department of National Parks and Wildlife' },
    parks: [
      park('south-luangwa', 'South Luangwa National Park', 'Eastern Province · Mfuwe', 'The home of the walking safari, with leopards, hippos and the Luangwa River.', ['Walking safaris', 'Night drives', 'Mfuwe gate'], parkRates(5000, 30000, 60000, 'Zambian citizen')),
      park('lower-zambezi', 'Lower Zambezi National Park', 'Lusaka Province · Chirundu', 'Canoeing and fishing on the Zambezi opposite Mana Pools.', ['Canoe safaris', 'Tiger fishing', 'Chongwe gate'], parkRates(5000, 30000, 60000, 'Zambian citizen'), 80),
      park('kafue', 'Kafue National Park', 'Central · Southern · Western', 'One of Africa’s largest parks, from the Busanga Plains to Lake Itezhi-Tezhi.', ['Busanga Plains', 'Lake Itezhi-Tezhi', 'Nalusanga gate'], parkRates(4000, 20000, 40000, 'Zambian citizen')),
    ],
    demoListings: {
      'nkhwazi-reserve': reserveListings('ZM', 'Nkhwazi Private Reserve', 'Lusaka', 'Game ranch outside Lusaka with antelope, zebra, birding and horse trails.', ['Near Lusaka', 'Birding', 'Horse trails']),
      'mwela-transfers': driverListings('ZM', 'Kenneth Kaunda (Lusaka)', 'Lusaka', 'Eastern Province · Mfuwe'),
      'nsefu-bend': [
        stay('mfuwe', 'Nsefu Bend Camp', 'Eastern Province · Mfuwe', 'River camp on the Luangwa, five minutes from the Mfuwe park gate.', ['River views', 'Game drives arranged', 'Pool'], 270000, 430000),
        stay('lusaka', 'Nsefu Bend Lusaka Lodge', 'Lusaka', 'Garden lodge in Kabulonga for business trips and family visits.', ['Wi-Fi', 'Secure parking', 'Restaurant'], 160000, 250000, 10, 'hotel'),
      ],
      'kafue-canoe': [
        safari('zambezi-canoe', 'Lower Zambezi canoe day', 'Lusaka Province · Chirundu', 'A guided canoe trip past hippos and elephants on the Zambezi, with lunch on a sandbank.', ['Licensed guide', 'Lunch included', 'Park fee included'], 190000, 95000, 1, 10),
        safari('luangwa-walk', 'South Luangwa walking safari', 'Eastern Province · Mfuwe', 'Three days on foot with an armed scout and guide, sleeping in bush camps.', ['All meals', 'Armed scout', 'Park fees included'], 1300000, 650000, 3, 6),
      ],
    },
  },
  ZW: {
    parksAgency: { code: 'ZimParks', name: 'Zimbabwe Parks and Wildlife Management Authority' },
    parks: [
      park('hwange', 'Hwange National Park', 'Matabeleland North', 'Zimbabwe’s largest park, with big herds of elephants at pumped waterholes.', ['Main Camp gate', 'Elephants', 'Self-drive or guided'], parkRates(1000, 1500, 3000, 'Zimbabwean citizen')),
      park('vic-falls', 'Victoria Falls Rainforest', 'Matabeleland North · Victoria Falls', 'The rainforest trail along the edge of Mosi-oa-Tunya, the smoke that thunders.', ['16 viewpoints', 'Rainbow views', 'Raincoats advised'], parkRates(700, 2000, 5000, 'Zimbabwean citizen'), 400),
      park('mana-pools', 'Mana Pools National Park', 'Mashonaland West', 'Floodplains on the Zambezi where walking among elephants is allowed with a guide.', ['Walking allowed', 'Canoeing', 'Permit office at Marongora'], parkRates(1000, 1500, 2500, 'Zimbabwean citizen'), 50),
    ],
    demoListings: {
      'nyamakuku-reserve': reserveListings('ZW', 'Nyamakuku Private Reserve', 'Matabeleland North · Victoria Falls', 'Private reserve on the Zambezi upstream of the Falls, with elephant, buffalo and river drives.', ['Zambezi river', 'Elephants', 'Sunset drives']),
      'mhepo-transfers': driverListings('ZW', 'Victoria Falls', 'Matabeleland North · Victoria Falls', 'Matabeleland North'),
      'mosi-gorge': [
        stay('falls', 'Mosi Gorge Lodge', 'Matabeleland North · Victoria Falls', 'Lodge on the Batoka Gorge rim, walking distance from the Falls entrance.', ['Gorge views', 'Walk to the Falls', 'Pool'], 15000, 24000),
        stay('hwange', 'Mosi Gorge Hwange Teak Camp', 'Matabeleland North', 'Tented camp under teak trees near Hwange’s Main Camp.', ['Near Main Camp', 'Waterhole', 'All meals'], 18000, 28000, 6, 'camp'),
      ],
      'spray-mist': [
        safari('falls-tour', 'Victoria Falls guided tour', 'Matabeleland North · Victoria Falls', 'A guided walk of the rainforest trail with the history of Mosi-oa-Tunya.', ['Entry fee included', 'Hotel pick-up', '2 to 3 hours'], 6000, 3000, 1, 15),
        safari('hwange-2day', 'Hwange 2-day safari', 'Matabeleland North', 'Two days of game drives with an overnight at a park lodge.', ['Park fees included', 'All meals', 'Small group'], 38000, 19000, 2, 8),
      ],
    },
  },
};
