-- Phase 2: one database per country cell.

-- Which country this database belongs to. Written once at first start; the
-- server refuses to start if KGOTLA_COUNTRY ever disagrees, because national
-- ID hashes, currency amounts and agencies are all country-specific.
CREATE TABLE cell_meta (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- UI language codes now come from the country pack (en, tn, and later zu, af, bem, sn …).
ALTER TABLE citizens DROP CONSTRAINT IF EXISTS citizens_lang_check;
ALTER TABLE citizens ADD CONSTRAINT citizens_lang_check CHECK (lang ~ '^[a-z]{2,3}$');
