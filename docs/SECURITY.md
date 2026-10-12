# Security

A national ID wallet is a national target. This page lists the controls built into Phase 1 and the work still required before real citizens use it.

## Controls in place

| Threat | Control |
|---|---|
| Stolen phone or shoulder-surfed PIN used to pay | Every payment needs the PIN at the moment of payment (step-up), not just at sign-in. 5 wrong PINs lock it for 15 minutes; the counter is updated in its own transaction so it cannot be rolled back. |
| AI assistant tricked into moving money (prompt injection) | The model has no tool that executes. It can only prepare actions, which the citizen must confirm with a PIN after seeing a read-back. Tool output is labelled as data. |
| Double payment from retries or double taps | Action rows are locked during execution and run once; ledger entries are idempotent on the action id. |
| Overdraft through races | Ledger posting locks all involved accounts in a fixed order and rejects any entry that would make a wallet negative. Tested with concurrent confirmations. |
| Book-keeping errors or tampering | Database triggers reject unbalanced entries and any UPDATE or DELETE on postings. A trial-balance check is exposed to admins and the CLI. |
| Undetected changes to history | `audit_log` is append-only and hash-chained; `verify-integrity` recomputes the chain. |
| Mass leak of national ID numbers | Omang numbers are stored only as keyed HMACs plus the last 4 digits; raw numbers are erased after enrolment. Selfies are never stored. |
| Over-sharing personal data | Selective disclosure: the citizen chooses each claim; tokens expire in 2 minutes; only claim names are logged. Document share links are random 192-bit tokens, stored hashed, time-limited and revocable. |
| Session theft | Opaque random session tokens stored hashed, 12-hour expiry, revocable at sign-out. |
| Officer overreach | Officers act only on their own agency's applications; every officer action is audited with their id. Citizens cannot call officer endpoints and vice versa. |
| Brute force and abuse | Rate limits on sign-in, enrolment, OTP, confirmations, verification and the assistant. OTPs allow 5 attempts. |
| Browser attacks | Strict Content-Security-Policy (no inline scripts, no third-party scripts), `frame-ancestors 'none'`, Helmet defaults, no secrets in the client, all output escaped. |
| Misconfiguration | The server refuses to start in production with demo mode on or a short `KGOTLA_SECRET`. |

## Required before a pilot

1. **Penetration test and code review** by an independent firm, including the USSD and issuer endpoints.
2. **Keys in an HSM or cloud KMS.** Move `KGOTLA_SECRET` and disclosure signing to Ed25519 keys held in a managed HSM so verifiers can check codes offline with a public key.
3. **Device binding and passkeys.** Bind sessions to a device key (WebAuthn/passkeys) in addition to the PIN; add SIM-swap checks with the operators before allowing transfers after a SIM change.
4. **Officer authentication.** Replace passwords with Entra ID / SSO and MFA, conditional access and privileged access reviews. Add forced password change for CLI-created accounts.
5. **Transaction limits and fraud rules.** Daily limits by assurance level, velocity checks, new-recipient cooling-off, and alerts into the SOC (Microsoft Sentinel or equivalent) from the audit log.
6. **Encryption.** TLS 1.2+ end to end; PostgreSQL encryption at rest with customer-managed keys; encrypted backups with tested restores.
7. **Data protection.** Register with the Information and Data Protection Commission under Botswana's Data Protection Act; publish a privacy notice in English and Setswana; data-retention schedule; DPIA for biometrics.
8. **Logging hygiene.** Ship structured logs to the SIEM with PII redaction verified; alert on audit-chain or trial-balance failures.
9. **Liveness vendor certification** (ISO 30107-3 presentation-attack detection) and bias testing across skin tones, as the blueprint requires.
