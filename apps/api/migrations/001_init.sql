-- Kgotla Phase 1 schema (Botswana cell).
-- Money is stored as integer thebe (1 BWP = 100 thebe). Never floats.
-- Personal identifiers (Omang) are stored as keyed hashes plus last 4 digits only.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Mock national registry. In production this schema does not exist: the
-- identity module calls the Omang registry over the government exchange.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS registry_mock;
CREATE TABLE registry_mock.people (
  omang        text PRIMARY KEY,
  first_name   text NOT NULL,
  last_name    text NOT NULL,
  dob          date NOT NULL,
  sex          text NOT NULL CHECK (sex IN ('F','M')),
  district     text NOT NULL,
  phone        text NOT NULL,
  licence_class text,
  licence_valid_to date,
  tax_compliant boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
CREATE TABLE citizens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omang_hash    text NOT NULL UNIQUE,
  omang_last4   text NOT NULL,
  first_name    text NOT NULL,
  last_name     text NOT NULL,
  dob           date NOT NULL,
  district      text NOT NULL,
  phone         text NOT NULL UNIQUE,
  loa           smallint NOT NULL CHECK (loa BETWEEN 1 AND 3),
  pin_hash      text NOT NULL,
  pin_failures  smallint NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  lang          text NOT NULL DEFAULT 'en' CHECK (lang IN ('en','tn')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE enrolments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omang_hash     text NOT NULL,
  omang          text NOT NULL,            -- kept only for the life of the enrolment
  otp_hash       text NOT NULL,
  otp_attempts   smallint NOT NULL DEFAULT 0,
  otp_verified   boolean NOT NULL DEFAULT false,
  liveness_score numeric(5,4),
  face_match     numeric(5,4),
  completed_at   timestamptz,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  subject_type text NOT NULL CHECK (subject_type IN ('citizen','officer')),
  subject_id   uuid NOT NULL,
  device_label text,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_subject ON sessions(subject_type, subject_id);

CREATE TABLE officers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  name          text NOT NULL,
  agency        text NOT NULL,              -- e.g. DRTS, CNR, BURS, MOH
  role          text NOT NULL CHECK (role IN ('caseworker','counter','admin')),
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Selective-disclosure presentations (what a citizen showed to a verifier).
CREATE TABLE disclosures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id  uuid NOT NULL REFERENCES citizens(id),
  audience    text NOT NULL,
  claims      jsonb NOT NULL,              -- claim names only, never values
  expires_at  timestamptz NOT NULL,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX disclosures_citizen ON disclosures(citizen_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Vault
-- ---------------------------------------------------------------------------
CREATE TABLE issuers (
  id           text PRIMARY KEY,           -- e.g. DRTS
  name         text NOT NULL,
  api_key_hash text NOT NULL
);

CREATE TABLE documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id  uuid NOT NULL REFERENCES citizens(id),
  type        text NOT NULL,               -- omang, driver_licence, tax_clearance, birth_certificate ...
  title       text NOT NULL,
  issuer_id   text NOT NULL REFERENCES issuers(id),
  ref         text,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  valid_to    timestamptz,
  status      text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','superseded','revoked')),
  data        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX documents_citizen ON documents(citizen_id, status);

CREATE TABLE share_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id),
  citizen_id  uuid NOT NULL REFERENCES citizens(id),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  views       integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Ledger: strict double entry. Every journal entry's postings sum to zero.
-- Citizen wallets are liabilities of Kgotla (negative balance = money owed
-- to the citizen); we expose balance as -sum(postings) for liability accounts.
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,         -- wallet:<citizen_id>, settlement:orange_money, payable:bpc ...
  kind        text NOT NULL CHECK (kind IN ('asset','liability','revenue','expense')),
  name        text NOT NULL,
  citizen_id  uuid REFERENCES citizens(id),
  allow_negative boolean NOT NULL DEFAULT false, -- for liability wallets: may the citizen go below zero? never.
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journal_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL,
  description     text NOT NULL,
  idempotency_key text UNIQUE,
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE postings (
  id         bigserial PRIMARY KEY,
  entry_id   uuid NOT NULL REFERENCES journal_entries(id),
  account_id uuid NOT NULL REFERENCES ledger_accounts(id),
  amount     bigint NOT NULL CHECK (amount <> 0)    -- debit positive, credit negative, in thebe
);
CREATE INDEX postings_account ON postings(account_id);
CREATE INDEX postings_entry ON postings(entry_id);

-- Enforce balance at commit time.
CREATE FUNCTION check_entry_balanced() RETURNS trigger AS $$
DECLARE s bigint;
BEGIN
  SELECT COALESCE(SUM(amount),0) INTO s FROM postings WHERE entry_id = NEW.entry_id;
  IF s <> 0 THEN
    RAISE EXCEPTION 'journal entry % does not balance (%)', NEW.entry_id, s;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER postings_balanced AFTER INSERT ON postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();

-- Postings are append-only.
CREATE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
CREATE TRIGGER postings_append_only BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE billers (
  id         text PRIMARY KEY,               -- bpc, wuc, mascom, orange, btc
  name       text NOT NULL,
  category   text NOT NULL CHECK (category IN ('electricity','water','airtime')),
  ref_label  text NOT NULL,
  ref_pattern text NOT NULL
);

-- ---------------------------------------------------------------------------
-- Confirmable actions: the ONLY path that moves money or submits on a
-- citizen's behalf. The app, USSD and the AI assistant all create actions;
-- execution requires the citizen's PIN (step-up) and happens exactly once.
-- ---------------------------------------------------------------------------
CREATE TABLE pending_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id  uuid NOT NULL REFERENCES citizens(id),
  type        text NOT NULL,
  params      jsonb NOT NULL,
  readback    jsonb NOT NULL,               -- [[label, value], ...] shown before confirmation
  amount      bigint NOT NULL DEFAULT 0,
  source      text NOT NULL CHECK (source IN ('app','assistant','ussd')),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed','cancelled','expired')),
  result      jsonb,
  error       text,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz
);
CREATE INDEX pending_actions_citizen ON pending_actions(citizen_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Government service engine
-- ---------------------------------------------------------------------------
CREATE TABLE service_templates (
  code          text PRIMARY KEY,           -- driver_licence_renewal, tax_clearance, birth_certificate_copy
  name          text NOT NULL,
  agency        text NOT NULL,
  fee           bigint NOT NULL DEFAULT 0,
  steps         jsonb NOT NULL,             -- ordered ["submitted","eye_test","approved","issued"]
  output        jsonb,                      -- document to issue on final step
  active        boolean NOT NULL DEFAULT true
);

CREATE TABLE applications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref           text NOT NULL UNIQUE,
  citizen_id    uuid NOT NULL REFERENCES citizens(id),
  template_code text NOT NULL REFERENCES service_templates(code),
  step          smallint NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','rejected')),
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX applications_citizen ON applications(citizen_id, created_at DESC);
CREATE INDEX applications_open ON applications(template_code, status);

CREATE TABLE application_events (
  id             bigserial PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id),
  step           smallint NOT NULL,
  actor          text NOT NULL,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Places, bookings, smart queue
-- ---------------------------------------------------------------------------
CREATE TABLE locations (
  id        text PRIMARY KEY,
  kind      text NOT NULL CHECK (kind IN ('clinic','passport','eye_test','office')),
  name      text NOT NULL,
  agency    text NOT NULL,
  capacity  smallint NOT NULL DEFAULT 2,     -- bookings per slot
  slot_times text[] NOT NULL DEFAULT '{}',
  services  text[] NOT NULL DEFAULT '{}',    -- for queue offices
  counter_count smallint NOT NULL DEFAULT 1
);

CREATE TABLE appointments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id  uuid NOT NULL REFERENCES citizens(id),
  location_id text NOT NULL REFERENCES locations(id),
  starts_at   timestamptz NOT NULL,
  purpose     text NOT NULL,
  status      text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled','attended')),
  application_id uuid REFERENCES applications(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX appointments_no_double ON appointments(citizen_id, starts_at) WHERE status = 'booked';
CREATE INDEX appointments_slot ON appointments(location_id, starts_at) WHERE status = 'booked';

CREATE TABLE queue_tickets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id text NOT NULL REFERENCES locations(id),
  service     text NOT NULL,
  day         date NOT NULL DEFAULT CURRENT_DATE,
  seq         integer NOT NULL,
  label       text NOT NULL,                 -- e.g. A-014
  citizen_id  uuid REFERENCES citizens(id),
  phone       text,
  status      text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','called','served','left')),
  counter     smallint,
  near_notified boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  called_at   timestamptz,
  UNIQUE (location_id, day, service, seq)
);
CREATE INDEX queue_waiting ON queue_tickets(location_id, day, status, created_at);

-- ---------------------------------------------------------------------------
-- Notifications and transactional outbox (SMS / push / WhatsApp adapters)
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id uuid NOT NULL REFERENCES citizens(id),
  title      text NOT NULL,
  body       text NOT NULL,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_citizen ON notifications(citizen_id, created_at DESC);

CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  topic        text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts     smallint NOT NULL DEFAULT 0,
  last_error   text
);
CREATE INDEX outbox_unprocessed ON outbox(id) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- USSD sessions
-- ---------------------------------------------------------------------------
CREATE TABLE ussd_sessions (
  session_id  text PRIMARY KEY,
  phone       text NOT NULL,
  state       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Tamper-evident audit log: each row carries the hash of the previous row.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text NOT NULL,                  -- citizen:<id> | officer:<id> | system | assistant:<citizen id>
  action     text NOT NULL,
  subject    text,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash  text NOT NULL,
  hash       text NOT NULL
);
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();


