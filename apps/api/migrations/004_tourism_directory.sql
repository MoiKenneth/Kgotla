-- Services directory and tourism.

-- Official portals of institutions Kgotla links to or is connected with.
-- status: linked (Kgotla opens their official site), connecting (partnership
-- in progress), connected (live through the partner hub or an agency link).
CREATE TABLE directory_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  sector      text NOT NULL CHECK (sector IN ('government','tax','banking','health','insurance','utilities','telecoms','education','tourism','transport','other')),
  url         text NOT NULL CHECK (url ~ '^https://'),
  description text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'linked' CHECK (status IN ('linked','connecting','connected')),
  partner_id  uuid REFERENCES partners(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name)
);

-- Hotels, lodges and camps; safari and tour operators.
ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_type_check;
ALTER TABLE partners ADD CONSTRAINT partners_type_check CHECK (type IN
  ('clinic','doctor','pharmacy','bank','mobile_money','insurer','utility','telco','school','employer','hotel','tour_operator'));

-- Something bookable: a place to stay, a safari or tour, or entry to a park.
-- Parks belong to a government agency (agency set, partner_id null);
-- stays and safaris belong to a partner.
CREATE TABLE tourism_listings (
  id            text PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('stay','safari','park')),
  name          text NOT NULL,
  region        text NOT NULL,
  description   text NOT NULL,
  highlights    text[] NOT NULL DEFAULT '{}',
  unit          text NOT NULL CHECK (unit IN ('room_night','person','person_day')),
  rates         jsonb NOT NULL,                -- [{key, label, price}] price in minor units per unit
  capacity      integer NOT NULL CHECK (capacity > 0), -- rooms, seats or permits per day
  duration_days integer NOT NULL DEFAULT 1 CHECK (duration_days BETWEEN 1 AND 30), -- fixed length of a safari
  cancel_hours  integer NOT NULL DEFAULT 48,   -- full refund if cancelled at least this long before the start
  partner_id    uuid REFERENCES partners(id),
  agency        text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((partner_id IS NULL) <> (agency IS NULL))
);
CREATE INDEX tourism_listings_kind ON tourism_listings(kind, region) WHERE active;

CREATE TABLE tourism_bookings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref          text NOT NULL UNIQUE,
  listing_id   text NOT NULL REFERENCES tourism_listings(id),
  citizen_id   uuid NOT NULL REFERENCES citizens(id),
  start_date   date NOT NULL,
  days         integer NOT NULL CHECK (days BETWEEN 1 AND 30),  -- nights for stays
  rate_key     text NOT NULL,
  quantity     integer NOT NULL CHECK (quantity BETWEEN 1 AND 20), -- rooms or people
  total        bigint NOT NULL CHECK (total >= 0),
  status       text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled','completed')),
  refunded     bigint NOT NULL DEFAULT 0,
  document_id  uuid REFERENCES documents(id),
  action_id    uuid REFERENCES pending_actions(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz
);
CREATE INDEX tourism_bookings_listing ON tourism_bookings(listing_id, start_date) WHERE status = 'confirmed';
CREATE INDEX tourism_bookings_citizen ON tourism_bookings(citizen_id, start_date DESC);
