# Countries

Kgotla runs one **cell** per country. Every cell is the same build; the country is chosen at start-up with `KGOTLA_COUNTRY` and comes from a **country pack** in `apps/api/src/countries/`.

## What a country pack holds

| Part | Used for |
|---|---|
| `nationalId` | Name and format of the national ID, how to clean up what people type (`normalise`) and how to show it (`display`). South Africa's ID is checked with its Luhn checksum and birth date. Stored only as an HMAC with a per-country prefix, plus the last 4 characters. |
| `phone` | Country calling code, number length and whether a leading `0` is dropped. Every number is stored in international form. |
| `currency` | Symbol and ISO code. Amounts are stored in minor units (cents, thebe, ngwee), as in Phase 1. |
| `agencies` | The licensing, civil registration and tax agencies, which own applications and officer accounts. |
| `services` | Licence renewal, birth certificate copy, tax clearance: titles, fees, steps and what gets issued to the Vault. |
| `billers`, `topUpSources` | Electricity, water and airtime billers (with reference formats) and mobile-money or bank sources for topping up. |
| `locations` | Offices, clinics and counters for bookings and the smart queue. |
| `limits`, `chips` | Transfer, bill and airtime limits, and the quick-amount buttons, sized to each currency. |
| `languages` | English everywhere; Setswana in Botswana. Other languages are listed as planned. |
| `demo` | Example citizens, sign-ups not yet enrolled, and officers, for demo cells only. |

The assistant's instructions and tool definitions, the USSD menus, the web app's labels and amounts, the officer console and the verifier all read from the pack. Nothing else in the code names a country.

A database is bound to one country the first time a cell starts (`cell_meta` table). A cell started with a different `KGOTLA_COUNTRY` refuses to run, so data can never be read with the wrong country's rules.

## Adding a country

1. Copy `za.ts` to `xx.ts`, change every field, and add it to `PACKS` in `index.ts`.
2. Add `XX` to the test list in `test/countries.test.ts` and to the allowed cells in `.github/workflows/deploy.yml`.
3. Add its flag to `apps/web/flags.js`.
4. Run `npm test`, then deploy with `XX` in `KGOTLA_CELLS`.

## Facts each country team must confirm

The packs use realistic but **unverified** details so the demo feels local. Before a pilot, someone with authority in each country must confirm or correct the items below. None of them changes the code, only the pack.

### All countries

- The USSD short code. Every cell uses `*321#` as a placeholder; each mobile network operator assigns the real one.
- Service fees, licence classes and processing steps, from the agency's current fee schedule.
- Bill reference formats (meter and account number lengths) and the biller list, from each utility's vending or collection partner.
- Wallet limits, which follow the central bank's e-money or payment-service rules.
- Which agency issues what, and the wording of issued documents.
- Office names, opening hours and counter numbers for the smart queue.

### South Africa (ZA)

- ID: 13 digits, `YYMMDD SSSS C A Z`, Luhn checksum. Confirm handling of non-citizen and older IDs with the Department of Home Affairs.
- Licence renewal fee (pack: R250) varies by province; the pack uses one national figure.
- Electricity: Eskom direct customers only; most metro customers buy from their municipality. A pilot picks one metro and its vending provider.
- Top-up: PayShap and Instant EFT are placeholders for a bank or payment-service partner.
- Regulators: SARB (payments), Information Regulator (POPIA).

### Namibia (NA)

- ID: 11 digits beginning with the birth date. Confirm the remaining digits' meaning with the Ministry of Home Affairs, Immigration, Safety and Security.
- NaTIS licence fee (pack: N$180) and birth certificate fee (pack: N$15).
- Electricity and water: City of Windhoek is used as the example; other towns and regional electricity distributors differ.
- Networks: MTC and TN Mobile (formerly Telecom Namibia's mobile service) and Paratus; confirm current brand names and that each sells airtime through an aggregator.
- Regulators: Bank of Namibia (payments); data protection law is still being finalised.

### Zambia (ZM)

- NRC: `NNNNNN/NN/N`. Confirm the format with the Department of National Registration, Passport and Citizenship.
- RTSA licence fee (pack: K350) and birth certificate fee (pack: K50); RTSA fees are set in fee units that change.
- Limits are higher than other cells because of the kwacha's value; confirm against Bank of Zambia mobile-money tiers.
- Regulators: Bank of Zambia (payments), Office of the Data Protection Commissioner (Data Protection Act 2021).

### Zimbabwe (ZW)

- National ID shown as `63-245718K42` (district code, serial, check letter, district of origin). Confirm with the Registrar General.
- Currency: the cell runs in **US dollars**, which most retail transactions use. ZiG (ZWG) is also legal tender; a second ZiG wallet is a later change to the ledger, not the pack. Confirm the currency policy and any requirement to offer ZiG pricing with the Reserve Bank of Zimbabwe.
- VID licence classes (pack uses classes 4 and 2) and fees (pack: US$20 renewal, US$5 birth certificate).
- Electricity: ZETDC prepaid (ZESA); water: City of Harare as the example.
- Regulators: Reserve Bank of Zimbabwe (payments), POTRAZ (data protection under the Cyber and Data Protection Act).

### Botswana (BW)

Unchanged from Phase 1; see [PILOT.md](PILOT.md).
