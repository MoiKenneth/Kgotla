-- Partner hub: clinics, doctors, pharmacies, banks, mobile-money operators,
-- insurers, utilities, telcos, schools and employers connect to Kgotla.
--
-- Onboarding: apply -> licence checked with the regulator -> approved by a
-- Kgotla admin with a set of capabilities -> API credentials -> live.
-- Access to a citizen always needs that citizen's consent, given in the app
-- with their PIN, and they can withdraw it at any time.

CREATE TABLE partners (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,            -- slug, also the issuer id for documents it issues
  type             text NOT NULL CHECK (type IN ('clinic','doctor','pharmacy','bank','mobile_money','insurer','utility','telco','school','employer')),
  legal_name       text NOT NULL,
  trading_name     text NOT NULL,
  registration_no  text NOT NULL,                   -- company or practice registration
  licence_no       text,                            -- regulator licence / practice number
  regulator        text NOT NULL,                   -- e.g. BHPC, Bank of Botswana
  licence_check    jsonb NOT NULL DEFAULT '{}'::jsonb,
  contact_name     text NOT NULL,
  contact_email    text NOT NULL UNIQUE,
  contact_phone    text NOT NULL,
  portal_password_hash text NOT NULL,
  status           text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','approved','rejected','suspended')),
  capabilities     text[] NOT NULL DEFAULT '{}',    -- what this partner may ask citizens for
  webhook_url      text,
  webhook_secret_version integer NOT NULL DEFAULT 1,
  review_note      text,
  reviewed_by      uuid REFERENCES officers(id),
  reviewed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- OAuth 2.0 client credentials. The secret is shown once and stored hashed.
CREATE TABLE partner_credentials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    uuid NOT NULL REFERENCES partners(id),
  client_id     text NOT NULL UNIQUE,
  secret_hash   text NOT NULL,
  label         text NOT NULL DEFAULT 'API key',
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_subject_type_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_subject_type_check
  CHECK (subject_type IN ('citizen','officer','partner_portal','partner_api'));

-- A partner asks; the citizen grants with their PIN, declines, or later revokes.
-- "subject" is a pairwise pseudonym: each partner sees a different id for the
-- same citizen, so partners cannot join their data on Kgotla ids.
CREATE TABLE consents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    uuid NOT NULL REFERENCES partners(id),
  citizen_id    uuid NOT NULL REFERENCES citizens(id),
  subject       text NOT NULL,
  scopes        text[] NOT NULL,
  purpose       text NOT NULL,
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','granted','declined','revoked','expired')),
  request_expires_at timestamptz NOT NULL,
  expires_at    timestamptz,                         -- grant end
  decided_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consents_citizen ON consents(citizen_id, status);
CREATE INDEX consents_partner_subject ON consents(partner_id, subject, status);

-- Invoices from partners (a clinic bill, a loan instalment). Paid only by the
-- citizen confirming a pay_request action with their PIN.
CREATE TABLE payment_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    uuid NOT NULL REFERENCES partners(id),
  citizen_id    uuid NOT NULL REFERENCES citizens(id),
  amount        bigint NOT NULL CHECK (amount > 0),
  reference     text NOT NULL,
  description   text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','declined','expired','cancelled')),
  action_id     uuid REFERENCES pending_actions(id),
  expires_at    timestamptz NOT NULL,
  paid_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id, reference)
);
CREATE INDEX payment_requests_citizen ON payment_requests(citizen_id, status);

-- Signed event notifications to the partner's webhook URL, with retries.
CREATE TABLE webhook_deliveries (
  id              bigserial PRIMARY KEY,
  partner_id      uuid NOT NULL REFERENCES partners(id),
  event           text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  attempts        smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status     integer,
  last_error      text,
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_partner ON webhook_deliveries(partner_id, id DESC);

-- Clinics and practices publish their own bookable locations.
ALTER TABLE locations ADD COLUMN partner_id uuid REFERENCES partners(id);

-- Demo cells only: a built-in webhook receiver so the whole loop can be seen without a partner server.
CREATE TABLE demo_webhook_inbox (
  id           bigserial PRIMARY KEY,
  partner_code text NOT NULL,
  event        text,
  signature_ok boolean NOT NULL,
  body         jsonb,
  received_at  timestamptz NOT NULL DEFAULT now()
);
