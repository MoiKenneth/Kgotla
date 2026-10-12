# API

JSON over HTTPS. Citizen and officer endpoints take `Authorization: Bearer <token>`. Errors look like `{"error": {"code": "insufficient_funds", "message": "…"}}`; `message` is written for the person using the app.

## Public

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness check |
| GET | `/v1/config` | Country, demo mode, assistant mode |
| POST | `/v1/enrol/start` | `{omang}` → `{enrolmentId, phoneMasked}` (+`demoOtp` in demo mode) |
| POST | `/v1/enrol/:id/otp` | `{code}` → `{ok}` |
| POST | `/v1/enrol/:id/liveness` | `{selfie: dataURL}` → `{passed, match}` |
| POST | `/v1/enrol/:id/complete` | `{pin, lang?}` → `{token}` |
| POST | `/v1/auth/login` | `{omang, pin}` → `{token}` |
| POST | `/v1/auth/logout` | Revoke the session |
| POST | `/v1/verify` | `{code}` → `{valid, claims, assuranceLevel}` or `{valid:false, reason}` |
| GET | `/s/:token` | Public page for a shared document |
| POST | `/v1/ussd` | USSD gateway callback (`sessionId`, `phoneNumber`, `text`) → `CON …` / `END …` |

## Citizen

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/me` | Everything the home screen needs: profile, balance, documents, applications, appointments, queue ticket, notifications, transactions, disclosures |
| PATCH | `/v1/me` | `{lang: "en"\|"tn"}` |
| POST | `/v1/me/notifications/read` | Mark all read |
| GET | `/v1/me/contacts` | Recent recipients |
| POST | `/v1/me/documents/:id/share` | `{hours}` → `{url, expiresAt}` |
| DELETE | `/v1/me/shares/:id` | Withdraw a share link |
| POST | `/v1/me/disclosures` | `{claims: ["name","over18",…]}` → `{qr, expiresAt}` |
| GET | `/v1/locations?kind=` | `clinic`, `passport`, `eye_test`, `office` |
| GET | `/v1/locations/:id/availability` | Free slots over the next 5 working days |
| POST | `/v1/me/appointments/:id/cancel` | Cancel |
| GET | `/v1/queue/offices` | Offices and people waiting |
| POST | `/v1/me/queue/leave` | Leave the queue |
| POST | `/v1/assistant` | `{messages:[{role,content}], lang}` → `{reply, actions, mode}` |

### Confirmable actions

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/actions` | `{type, params}` → pending action with `readback`, `requiresPin` |
| GET | `/v1/actions/:id` | Current state |
| POST | `/v1/actions/:id/confirm` | `{pin?}` → executed action with `result` |
| POST | `/v1/actions/:id/cancel` | Cancel |

| `type` | `params` | PIN |
|---|---|---|
| `send_money` | `{to: phone, amount}` | yes |
| `pay_bill` | `{biller: "bpc"\|"wuc", ref, amount}` | yes |
| `buy_airtime` | `{network: "mascom"\|"orange"\|"btc", amount, phone?}` | yes |
| `top_up` | `{source: "orange_money"\|"myzaka", amount}` | yes |
| `licence_renewal` | `{eyeTest: {locationId, startsAt}}` | yes |
| `birth_certificate` | `{}` | yes |
| `tax_clearance` | `{}` | no |
| `book_appointment` | `{locationId, startsAt, purpose?}` | no |
| `queue_ticket` | `{locationId, service}` | no |

Amounts are pula as a string or number with at most 2 decimals (`"125.50"`); responses carry thebe integers plus formatted text.

## Issuers

`POST /v1/issuer/documents` with headers `x-issuer-id`, `x-issuer-key` and body `{omang, type, title, ref?, validTo?, data?}` puts a document into the citizen's Vault and notifies them.

## Officers

| Method | Path | Role |
|---|---|---|
| POST | `/v1/officer/login` | `{username, password}` |
| GET | `/v1/officer/applications?status=open` | caseworker (own agency), admin |
| POST | `/v1/officer/applications/:id/advance` | caseworker |
| POST | `/v1/officer/applications/:id/reject` | caseworker; `{reason}`; refunds fees |
| GET | `/v1/officer/offices` | counter |
| GET | `/v1/officer/queue/:locationId` | counter |
| POST | `/v1/officer/queue/:locationId/call-next` | counter; `{counter}` |
| GET | `/v1/officer/overview` | admin; includes ledger balance and audit-chain status |
