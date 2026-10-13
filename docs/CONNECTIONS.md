# Connecting existing portals

Every sector already has its own portal: BURS e-Tax for tax, banks' internet banking, hospital websites. Kgotla does not replace them on day one. It brings them together in two stages:

1. **Linked (now).** The institution appears in the app under **All services**, grouped by sector, with a short description. Tapping it opens the institution's own official website. Kgotla admins manage the list in the officer console (Directory tab): add, edit, remove, and change status.
2. **Connected (after a partnership).** The institution joins through the partner hub ([PARTNERS.md](PARTNERS.md)) or a government data link. Its services then work inside Kgotla: consent with PIN, documents in the Vault, bills paid from the wallet, bookings, notifications. The directory entry changes to "In Kgotla".

Between the two, an entry can be marked **Connecting soon** while the agreement and integration are under way.

> Kgotla never signs in to another institution's portal on a citizen's behalf, never asks for their passwords to those portals, and never scrapes them. That would break the institutions' terms, put citizens' accounts at risk, and stop working whenever a page changes. Every live connection is an agreed API with the institution.

## The three portals you named

None of the three publishes an API for third parties today. Their public pages mention no developer portal or integration programme, so each connection starts with a conversation and an agreement.

### BURS e-Tax (Botswana Unified Revenue Service)

| | |
|---|---|
| What the portal offers today | Sign-in and registration, filing returns and reconciling payments, obligation reminders, taxpayer profile, wage-subsidy applications, and public checks of Tax Clearance Certificates and Transfer Duty. |
| In Kgotla now | Listed under **Tax** and opens the official portal. Kgotla's tax-clearance flow runs against a mock registry. |
| How it connects | BURS is a government agency, so it connects through the government data exchange (or a direct agency API under a memorandum of understanding), not the commercial partner hub. |
| First things to connect | 1. Tax-clearance status check by Omang (replaces the mock in `tax_clearance`). 2. BURS issues certificates straight into the citizen's Vault through the issuer API (`POST /v1/issuer/documents`), which already exists. 3. Kgotla verifiers check a TCC through BURS's verification service instead of a photo of a paper certificate. 4. Later: tax payments from the Kgotla wallet with a BURS payment reference, settled to BURS's collection account. |
| Who to approach | BURS ICT and taxpayer services, through the Ministry overseeing the Kgotla programme. |

### FNB Botswana

| | |
|---|---|
| What the portal offers today | Online banking, eWallet (personal and business), payments, statement and payment verification, and account confirmation letters. |
| In Kgotla now | Listed under **Banking** and opens fnbbotswana.co.bw. |
| How it connects | As a **bank** partner in the partner hub. FNB applies at `/partners.html`; Kgotla checks its Bank of Botswana licence and approves it. |
| First things to connect | 1. **eKYC account opening.** FNB asks a customer for `identity.kyc`; the customer approves with their PIN; FNB receives verified identity with a signed attestation, with no branch visit. 2. **Statements and confirmation letters to the Vault** (`documents.issue`: `bank_statement`, `bank_confirmation_letter`), so customers can share them with landlords or employers through Kgotla share links. 3. **Top up the Kgotla wallet from an FNB account or eWallet**: add FNB as a top-up source once FNB exposes a collection API. 4. **Loan instalments as bills** (`payments.request`). |
| What FNB's IT builds | An OAuth client for the Kgotla API and a webhook endpoint. Typically a few weeks against a demo cell; [PARTNERS.md](PARTNERS.md) has the checklist. |
| Who to approach | FNB Botswana digital banking and the compliance team (for the KYC reliance clause). |

### Life Gaborone Private Hospital (Life Healthcare)

| | |
|---|---|
| What the portal offers today | Information on departments, specialists, emergency, maternity, oncology and radiology, and online payment of hospital accounts. No online appointment booking is listed. Segoditshane Road, Gaborone, +267 368 5600. |
| In Kgotla now | Listed under **Health** and opens the hospital's page. |
| How it connects | As a **clinic or hospital** partner. Kgotla checks its Ministry of Health facility licence. Because the group runs hospitals in several countries, one integration can serve every Kgotla cell where it operates. |
| First things to connect | 1. **Bookable clinics and specialist slots** in the app (`PUT /v1/partner/locations`), with bookings sent to the hospital's system by webhook. 2. **Hospital accounts as bills** paid from the wallet with PIN (`payments.request`), instead of card payments on the website. 3. **Results, sick notes, discharge summaries and prescriptions** into the patient's Vault (`documents.issue`). 4. Later: an HL7 FHIR connection to the hospital's patient-records system, so records flow without custom code. |
| Who to approach | Life Healthcare's Botswana hospital management and the group's IT/digital team. |

## Bringing on many institutions

You have many portals to connect. A workable order:

1. **List them all as "linked" now.** Add every portal to the directory in the officer console. Citizens get one place to find everything from the first release.
2. **Pick five anchor partners**, one per sector, with the most citizen traffic: tax, one bank, one hospital group, one utility, one tourism body. Sign agreements with these first.
3. **Run each anchor through the partner hub** in a demo cell, then live with a small group.
4. **Publish the results** (time saved, queues avoided). The next institutions in each sector then usually ask to join, and the partner portal lets them onboard themselves with only a review from your team.
5. **Government agencies** go through the government exchange and the issuer API in parallel. They need a ministerial mandate more than a commercial agreement.

Track each institution's status in the directory (linked → connecting → connected), so the officer console also serves as your onboarding pipeline.
