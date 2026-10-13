-- Real-money payments in, live (open) sign-up, and more tourism.

-- Money coming in from outside Kgotla: PayPal, DPO Pay (cards and mobile money),
-- or the demo test gateway. A payment either tops up the wallet, or tops it up
-- and immediately pays a prepared action (a booking, a bill).
CREATE TABLE external_payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id       uuid NOT NULL REFERENCES citizens(id),
  provider         text NOT NULL CHECK (provider IN ('paypal','dpo','test')),
  purpose          text NOT NULL CHECK (purpose IN ('top_up','action')),
  action_id        uuid REFERENCES pending_actions(id),
  amount           bigint NOT NULL CHECK (amount > 0),     -- credited to the wallet, local minor units
  currency         text NOT NULL,                          -- local currency code
  charged_amount   bigint,                                 -- what the provider charges, its minor units
  charged_currency text,
  provider_ref     text,                                   -- PayPal order id, DPO transaction token
  status           text NOT NULL DEFAULT 'created' CHECK (status IN ('created','pending','paid','failed','cancelled','expired')),
  provider_state   jsonb NOT NULL DEFAULT '{}'::jsonb,
  error            text,
  entry_id         uuid REFERENCES journal_entries(id),
  action_result    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  UNIQUE (provider, provider_ref)
);
CREATE INDEX external_payments_citizen ON external_payments(citizen_id, created_at DESC);
CREATE INDEX external_payments_open ON external_payments(created_at) WHERE status IN ('created','pending');

-- Open sign-up (no registry link yet): details the person declared at enrolment.
ALTER TABLE enrolments ADD COLUMN declared jsonb;

-- Tourism: more kinds and pricing units.
ALTER TABLE tourism_listings DROP CONSTRAINT IF EXISTS tourism_listings_kind_check;
ALTER TABLE tourism_listings ADD CONSTRAINT tourism_listings_kind_check CHECK (kind IN ('stay','safari','park','reserve','driver'));
ALTER TABLE tourism_listings DROP CONSTRAINT IF EXISTS tourism_listings_unit_check;
ALTER TABLE tourism_listings ADD CONSTRAINT tourism_listings_unit_check CHECK (unit IN ('room_night','person','person_day','vehicle_day','trip'));
-- Lodge, hotel, camp, guesthouse (stays); airport transfer, driver-guide, self-drive with driver (drivers).
ALTER TABLE tourism_listings ADD COLUMN category text;

ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_type_check;
ALTER TABLE partners ADD CONSTRAINT partners_type_check CHECK (type IN
  ('clinic','doctor','pharmacy','bank','mobile_money','insurer','utility','telco','school','employer','hotel','tour_operator','game_reserve','transport'));
