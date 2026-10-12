# Pilot readiness

The platform logic is real and tested. The connections to the outside world are **adapters**, each with a mock used in demo mode. A pilot replaces each mock with a real integration and gets the approvals below.

## Integrations to build

| Adapter (code) | Mock today | Production integration | Owner to engage |
|---|---|---|---|
| `Registry` (identity.ts) | `registry_mock.people` table | Omang lookup over the government data exchange; licence and tax status from DRTS and BURS | Ministry of Communications and Innovation; Civil & National Registration; DRTS; BURS |
| `Liveness` (identity.ts) | accepts any image > 2 KB | Certified liveness + 1:1 face match vendor, matching against the registry photo | Vendor (ISO 30107-3) |
| `SmsGateway` (notify.ts) | logs messages | Bulk SMS API (Africa's Talking, Orange, Mascom) | Mobile network operators |
| USSD `/v1/ussd` | `/ussd.html` simulator | Short code `*321#` routed to the callback | Mobile network operators, BOCRA |
| `top_up` action | credits immediately | Mobile-money collection request with confirmation callback; credit the wallet on success | Orange Money, MyZaka |
| `Vending` (actions.ts) | random token | BPC prepaid vending API; operator airtime APIs | BPC, Mascom, Orange, BTC |
| Wallet custody | internal ledger only | Funds held at a partner bank (trust account) or under an e-money licence; daily reconciliation of `settlement:*` and `payable:*` accounts | Partner bank; Bank of Botswana |
| Issuer API `/v1/issuer/documents` | demo keys | Mutual TLS + per-issuer keys from the CLI for CNR, DRTS, BURS, BEC, MOH | Each issuing institution |
| `ANTHROPIC_API_KEY` | basic mode without it | Claude via the Anthropic API (or a regional cloud provider), with a data-processing agreement | Anthropic / cloud provider |

## Approvals

- **Bank of Botswana**: e-money or payment-service licensing route (partner bank first, own licence later), regulatory sandbox if available.
- **Information and Data Protection Commission**: registration, DPIA for biometric processing, cross-border transfer review for any processing outside Botswana.
- **Government MoU**: data-sharing agreement with the registry and agencies; service-level agreements for the exchange.
- **Hosting**: in-country hosting or the nearest compliant region, agreed with the data protection authority. One country cell = one deployment and one database.

## Product work before launch

- Setswana copy reviewed by native speakers and tested with users at a primary-school reading level.
- Accessibility review (screen readers, large text, colour contrast).
- Agent network: "Help me" hand-off routing to real agents (`agent.callback` outbox topic is in place).
- Officer onboarding with SSO; supervisor views; service-level timers on applications.
- Load test at expected Phase 1 volumes (1M registered, 40 services).
- Monitoring: health checks, outbox lag, failed-action rates, ledger and audit integrity alerts.

## Running in production

```bash
NODE_ENV=production DEMO_MODE=false KGOTLA_SECRET=<64 random chars from a vault> \
DATABASE_URL=postgres://… PUBLIC_BASE_URL=https://app.kgotla.example \
node apps/api/dist/src/server.js

# create staff accounts and issuer keys
npm run cli -w apps/api -- create-officer kmolefe "Kagiso Molefe" DRTS caseworker
npm run cli -w apps/api -- rotate-issuer-key DRTS
npm run cli -w apps/api -- verify-integrity
```
