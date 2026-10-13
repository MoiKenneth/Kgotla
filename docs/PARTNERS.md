# Onboarding partners: clinics, doctors, banks and others

Kgotla connects citizens to the organisations that serve them: clinics, hospitals, doctors, pharmacies, banks, mobile-money operators, insurers and medical aids, utilities, mobile networks, schools and employers. This guide covers both halves of bringing one on: the **business onboarding** your team runs, and the **technical integration** their developers build.

Government agencies connect differently: they issue documents through the issuer API and work in the officer console (see [API.md](API.md)).

## How a partner connects, end to end

```
 Partner                          Kgotla team                       Citizen
 ───────                          ───────────                       ───────
 1. Applies at /partners.html ─►  licence checked with regulator
                                  2. Reviews in officer console,
                                     approves only what is needed
 3. Creates API keys, sets a
    webhook URL in the portal
 4. Tests in the demo cell
 5. Asks a person for consent ──────────────────────────────────►  6. Approves in the app
                                                                      with their PIN
 7. Gets a "subject" id  ◄───────── consent.granted webhook
 8. Issues documents, sends bills, ────────────────────────────►  9. Pays bills with PIN,
    publishes clinic slots,                                           books slots, finds
    verifies identity                                                 documents in the Vault
                                                                  10. Can withdraw access
                                                                      at any time
```

The safety rules behind this:

- **Nothing about a person is shared without their consent**, given in the app with their PIN, for named purposes, for 12 months at most. They see every connected organisation under Settings → Connected organisations and can withdraw access in one tap; access stops at once and the partner gets a `consent.revoked` webhook.
- **Partners never see Kgotla's internal ids.** Each partner gets its own pseudonymous `subject` id per person, so two partners cannot match their records through Kgotla.
- **No partner can take money.** A partner sends a bill; only the citizen pays it, with their PIN, through the same confirmable-action path as every other payment.
- **Partners get only what their type needs.** A clinic cannot ask for full KYC; a bank cannot publish clinic slots or issue sick notes.
- **Every step is in the hash-chained audit log**: application, approval, consent, each identity read, each document and bill.
- **No nagging.** After someone declines or withdraws, the same organisation must wait 7 days before asking again.

## Part 1: business onboarding (your team)

### Stages

| Stage | Who | What happens | Done when |
|---|---|---|---|
| 1. Prospect | Kgotla partnerships | Agree the first use case (for example "sick notes and bills to patients' phones"). Share this guide and the portal link. | Partner agrees to proceed |
| 2. Agreements | Legal on both sides | Sign the partner agreement, data processing agreement and API terms (see below). Banks and insurers add a KYC reliance clause. | Signed copies filed |
| 3. Application | Partner | Applies at `/partners.html` with registration and licence numbers. Kgotla checks the licence with the regulator automatically. | Application in the officer console |
| 4. Due diligence | Kgotla admin | Confirms the company registration and licence, checks the contact person works there, screens sanctions lists for financial partners, and approves only the capabilities the use case needs. | Approved in the officer console |
| 5. Build and test | Partner developers | Create API keys, set a webhook, build against a **demo cell** (example people and money). | Certification checklist passes (below) |
| 6. Go live | Both | Partner gets keys in the live cell. Start with a small group (one clinic, one branch). | First real citizens connected |
| 7. Operate | Kgotla support | Watch failed webhooks and complaints in the officer console. Review each partner yearly. | Ongoing |
| 8. Offboard | Kgotla admin | Suspend in the officer console: tokens and keys stop at once. Citizens keep the documents already issued. | Partner suspended |

### Agreements to have in place

- **Partner agreement**: who the parties are, the use case, fees, service levels, liability, termination, and that the partner may only ask citizens for what the use case needs.
- **Data processing agreement**, under each country's data protection law (Botswana Data Protection Act; South Africa POPIA; Zambia Data Protection Act 2021; Zimbabwe Cyber and Data Protection Act; Namibia's law when enacted). It covers purpose limitation, retention, breach notification within agreed hours, and deletion when consent is withdrawn.
- **API terms**: key security, rate limits, webhook verification, and no screen-scraping or sharing of subject ids.
- **Banks, mobile-money operators and insurers**: a KYC reliance clause stating what Kgotla's identity check covers (registry match and face match at enrolment, assurance level 3) and that the partner stays responsible for its own AML and CFT duties. Confirm with each country's financial intelligence unit whether reliance on a third party's verification is allowed.
- **Health partners**: confirm with the health regulator that sending sick notes, prescriptions and results to a patient's Vault is permitted, and how long the clinic must keep its own copy.

> Money: Kgotla wallets hold citizens' money, so operating them for real needs an e-money or payment-service licence or a sponsor bank in each country. That is the precondition for real bill payments, and it belongs in the pilot plan ([PILOT.md](PILOT.md)).

### What each type of partner can do

The regulator shown is the one Kgotla checks the licence against; every cell lists its own (`GET /v1/partners/catalogue`). Confirm each with the country team before a pilot.

| Partner | Typical first use | Capabilities | Documents it can issue | Licence checked with (Botswana example) |
|---|---|---|---|---|
| Clinic or hospital | Bookable slots in the app, sick notes and results in the Vault, bills paid by phone | identity.basic, documents.issue, payments.request, notifications.send, locations.manage | medical_certificate, prescription, lab_result, vaccination_record, referral_letter, discharge_summary | Ministry of Health facility licence |
| Doctor or private practice | Same as a clinic, for one practice | same as clinic | medical_certificate, prescription, lab_result, referral_letter | BHPC |
| Pharmacy | Check a prescription is in the person's Vault; bill them | identity.basic, documents.read, payments.request, notifications.send | dispensing_record | BoMRA |
| Bank | Open an account without a branch visit (eKYC); statements to the Vault; loan instalment bills | identity.basic, identity.kyc, documents.read, documents.issue, payments.request, notifications.send | bank_statement, bank_confirmation_letter, loan_agreement | Bank of Botswana |
| Mobile-money operator | eKYC for wallet tiers; collections | identity.basic, identity.kyc, payments.request, notifications.send | wallet_statement | Bank of Botswana |
| Insurer or medical aid | eKYC; policy and medical-aid card in the Vault; premiums | identity.basic, identity.kyc, documents.read, documents.issue, payments.request, notifications.send | insurance_policy, medical_aid_card, claim_statement | NBFIRA |
| Utility | Statements and connection certificates; bills | identity.basic, documents.issue, payments.request, notifications.send | utility_statement, connection_certificate | BERA |
| Mobile network | SIM registration with verified identity | identity.basic, identity.kyc, documents.issue, payments.request, notifications.send | sim_registration, account_statement | BOCRA |
| School, college, university | Reports, certificates and transcripts in the Vault; fees | identity.basic, documents.issue, payments.request, notifications.send | school_report, certificate, enrolment_letter, transcript | Ministry of Education and Skills Development |
| Employer | Payslips and employment letters in the Vault | identity.basic, identity.kyc, documents.issue, notifications.send | payslip, employment_letter, tax_certificate_employee | CIPA |

Regulators for South Africa, Namibia, Zambia and Zimbabwe are in `apps/api/src/countries/partners.ts`. For example, doctors are checked with HPCSA, HPCNA, HPCZ and MDPCZ respectively.

### Admin review checklist

In the officer console (Partners tab, admin accounts only):

1. **Licence check**: green "LICENCE VERIFIED" means the regulator register lists the number. Red means stop and ask.
2. **Company registration**: look the number up in the company registry (CIPA, CIPC, BIPA, PACRA, Companies Registry).
3. **Contact person**: call the organisation's published switchboard, not the number on the form, and confirm the contact works there.
4. **Financial partners**: screen the company and directors against sanctions lists.
5. **Capabilities**: untick anything the agreed use case does not need.
6. **Approve.** The partner can now create keys. Suspending later cuts off its API access immediately.

## Part 2: technical integration (partner developers)

Base URL: `https://<cell>/v1`, for example `https://kgotla-bw.<region>.azurecontainerapps.io/v1`. Every country cell is separate: a partner in two countries onboards in each.

### 1. Get an access token (OAuth 2.0 client credentials)

Create a key in the portal (the secret is shown once), then:

```bash
curl -s https://<cell>/v1/oauth/token \
  -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=client_credentials
# {"access_token":"…","token_type":"Bearer","expires_in":3600,"scope":"identity.basic documents.issue …"}
```

`client_id` and `client_secret` can also go in the form or a JSON body. Tokens last one hour; get a new one when a call returns 401.

### 2. Ask a person for consent

```bash
curl -s https://<cell>/v1/partner/consents -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{
  "nationalId": "435721904",
  "scopes": ["identity.basic", "documents.issue", "payments.request"],
  "purpose": "Your patient file, sick notes and bills from Thusong Family Clinic"
}'
# 201 {"consentId":"…","status":"requested","subject":null,"requestExpiresAt":"…"}
```

Send `phone` instead of `nationalId` if that is what you hold. The person gets an SMS and sees the request in the app, with your name, licence and purpose. Requests expire after 48 hours. Asking again with the same scopes returns the same request; if access is already granted you get it straight back with status 200.

| Scope | The person sees |
|---|---|
| `identity.basic` | Your name and the last 4 characters of your ID |
| `identity.kyc` | Your verified identity: full name, date of birth, district, phone number and ID check result |
| `documents.read` | A list of the documents in your Vault (titles, references and expiry dates) |
| `documents.issue` | Put documents in your Vault, such as sick notes, prescriptions, results or statements |
| `payments.request` | Send you bills to pay. You approve every payment with your PIN |
| `notifications.send` | Send you messages and reminders |

### 3. Learn the outcome

Either handle the `consent.granted` webhook, or poll:

```bash
curl -s https://<cell>/v1/partner/consents/$CONSENT_ID -H "authorization: Bearer $TOKEN"
# {"status":"granted","subject":"sub_8f2c…","scopes":[…],"expiresAt":"…"}
```

Store the `subject` against your customer or patient record. It is the only id you use from now on.

### 4. Use what was granted

| Call | Needs | What it does |
|---|---|---|
| `GET /partner/citizens/{subject}/identity` | identity.basic or identity.kyc | Claims plus a signed `attestation` to keep as KYC evidence. Never returns the full ID number. |
| `GET /partner/citizens/{subject}/documents` | documents.read | Titles, types, references and expiry dates of valid documents |
| `POST /partner/citizens/{subject}/documents` | documents.issue | `{type, title, ref?, validTo?, data?}`; the type must be one your partner type may issue. The person gets an SMS. |
| `POST /partner/citizens/{subject}/payment-requests` | payments.request | `{amount, reference, description, expiresInHours?}`; idempotent on `reference` |
| `GET /partner/payment-requests/{id}`, `POST …/{id}/cancel` | | Status: pending, paid, declined, expired, cancelled |
| `POST /partner/citizens/{subject}/notifications` | notifications.send | `{title, body, sms?}` |
| `PUT /partner/locations` | locations.manage | `{key, name, capacity, slotTimes:["08:30",…]}`; appears under "Book a clinic" in the app |
| `GET /partner/appointments?from=YYYY-MM-DD&days=14` | locations.manage | Bookings at your locations, with patient name and subject |
| `POST /partner/appointments/{id}/attended` | locations.manage | Mark a visit as attended |
| `GET /partner/me` | | Your approval, capabilities and locations |

Errors are JSON `{"error":{"code","message"}}`. The ones to handle: `consent_required` (403: ask for consent), `recently_declined` (429: wait), `invalid_document_type` (400), `duplicate_reference` (409), `not_approved` (403).

### 5. Webhooks

Set the URL in the portal. Events: `consent.granted`, `consent.declined`, `consent.revoked`, `payment_request.paid`, `payment_request.declined`, `appointment.booked`, `appointment.cancelled`, `partner.approved`, `partner.suspended`, `ping`.

```json
{ "id": "evt_…", "type": "payment_request.paid", "created": "2026-10-13T13:53:02.114Z",
  "data": { "paymentRequestId": "…", "reference": "INV-1042", "amount": 35000, "currency": "BWP", "subject": "sub_…", "paidAt": "…" } }
```

Amounts are in minor units (thebe, cents, ngwee). Every request carries:

- `Kgotla-Event`: the event type
- `Kgotla-Delivery`: the delivery id. Retries reuse it, so use it to ignore duplicates
- `Kgotla-Signature`: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`

Reply with any 2xx within 8 seconds. Failed deliveries are retried after 30 s, 2 min, 10 min, 1 h, 6 h and 24 h, then marked failed (visible in the portal and to Kgotla admins).

Verify the signature against the **raw** request body:

```js
// Node.js (Express: app.post('/kgotla/events', express.raw({ type: 'application/json' }), handler))
const crypto = require('node:crypto');
function verifyKgotla(rawBody, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const want = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return want.length === parts.v1?.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(parts.v1));
}
```

```python
# Python
import hmac, hashlib, time
def verify_kgotla(raw_body: bytes, header: str, secret: str, tolerance=300) -> bool:
    parts = dict(kv.split("=", 1) for kv in header.split(","))
    t = int(parts.get("t", 0))
    if not t or abs(time.time() - t) > tolerance:
        return False
    want = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, parts.get("v1", ""))
```

### 6. Test in a demo cell

Every demo cell has an approved demo clinic and bank and a doctor waiting for review. On a local cell the API keys are `demo-clinic` / `demo-clinic-secret` and `demo-bank` / `demo-bank-secret`. Portal sign-ins are `clinic@demo.kgotla`, `bank@demo.kgotla` and `doctor@demo.kgotla`, with the demo officer password. Demo partners' webhooks point at a built-in receiver, so the portal shows deliveries arriving and their signatures checking out.

### Certification checklist before go-live

A partner's integration is ready when, in a demo cell, it:

1. Gets a token and refreshes it on a 401.
2. Sends a consent request and handles **granted**, **declined** and **expired**.
3. Stores the `subject`, never a national ID number, after consent.
4. Verifies webhook signatures, rejects a tampered body, and ignores a repeated `Kgotla-Delivery`.
5. Handles `consent.revoked` by stopping all use of that person's data and deleting what the data processing agreement says to delete.
6. Uses a unique `reference` per bill and handles `payment_request.paid` exactly once.
7. Shows the person's name and purpose wording the way it appears in the app (no surprises).
8. Keeps API secrets in a secrets store, never in a mobile app or browser.

## What is real today and what comes next

Working now, with integration tests: applying, the licence check (through an adapter), admin review, API keys, OAuth tokens, consent with PIN, withdrawal, pairwise subjects, eKYC claims with attestation, document issuing, bills paid with PIN, clinic slots and bookings, signed webhooks with retries, suspension, the partner portal, the officer Partners tab, and the citizen screens. This works in all five country cells.

Before a pilot:

- **Regulator registers.** The licence check is a demo adapter (`MockRegulator`). Build one adapter per regulator: an API where one exists, otherwise a data file the regulator publishes, or a manual check recorded by the admin.
- **Settlement.** Paid bills are owed to the partner in the ledger (`payable:partner:<id>`), but nothing pays them out yet. Add a daily settlement file or instant transfer to the partner's bank account, and reconcile it.
- **Attestation keys.** The identity attestation is signed with the cell's HMAC key. For partners to verify it offline, switch to an asymmetric key held in Key Vault or an HSM and publish the public key.
- **Health records standards.** For hospital and clinic systems, add an HL7 FHIR R4 facade (Patient, Appointment, DocumentReference) over these endpoints, so electronic medical record systems connect without custom code.
- **Partner email.** Approval and suspension notices go to the webhook and portal only; add email.
- **Per-partner rate limits and usage billing**, if partners pay per verification or per transaction.
- **Membership privacy.** A consent request for someone without a Kgotla account returns 404, which tells an approved partner that the person has no account. Decide whether that is acceptable, or always answer "requested" and silently drop it.
