-- OPD / Emergency Token & Billing System — initial schema
--
-- Design notes that matter:
--  * Token (daily, disposable) and Invoice (annual, permanent) are SEPARATE series.
--  * Token numbers come from token_counter via upsert-returning, never a sequence.
--    Sequences are non-transactional, advance on ON CONFLICT, and cannot be reset
--    safely by cron. A gap in a hospital token series reads as a deleted bill.
--  * visit_item snapshots name and price. Raising a catalogue price must never
--    retroactively change an old bill.

set timezone = 'Asia/Karachi';

-- ---------------------------------------------------------------- clinic setup

create table clinic_setting (
  id           smallint primary key default 1,
  name         text    not null default 'Clinic',
  address      text    not null default '',
  phone        text    not null default '',
  footer_note  text    not null default '',
  paper_width  smallint not null default 80,   -- 58 or 80 (mm)
  constraint clinic_setting_singleton check (id = 1),
  constraint clinic_setting_paper check (paper_width in (58, 80))
);

insert into clinic_setting (id) values (1);

-- Counter staff. Single shared login was chosen, so this is a no-password
-- "who is at the counter" picker. It exists purely so every money-touching
-- row carries an actor for the audit log.
create table staff (
  id      bigint generated always as identity primary key,
  name    text    not null,
  active  boolean not null default true
);

insert into staff (name) values ('Reception');

-- ---------------------------------------------------------------- token series

-- The admin renames prefixes freely (NORM -> OPD). The counter keys on
-- series_id, never the code string, so a rename cannot disturb history.
create table token_series (
  id           bigint generated always as identity primary key,
  code         text    not null unique,      -- NORM, ER
  label        text    not null,             -- "Normal OPD"
  is_emergency boolean not null default false,
  base_fee     numeric(10,2) not null default 0,
  active       boolean not null default true,
  sort_order   smallint not null default 0
);

insert into token_series (code, label, is_emergency, base_fee, sort_order) values
  ('NORM', 'Normal OPD', false, 500, 1),
  ('ER',   'Emergency',  true, 1500, 2);

-- ---------------------------------------------------------------- patients

create table patient (
  id         bigint generated always as identity primary key,
  mrn        text        not null unique,     -- MRN-000451, permanent identity
  name       text        not null,
  phone      text        not null default '',
  gender     text        not null,
  age_years  smallint,
  address    text        not null default '',
  created_at timestamptz not null default now(),
  constraint patient_gender check (gender in ('MALE','FEMALE','OTHER'))
);

-- Phone is the lookup key (not the identity) — it is shared across families
-- and reused. Indexed for the hot-path autofill.
create index patient_phone_idx on patient (phone) where phone <> '';
create index patient_name_idx  on patient using gin (to_tsvector('simple', name));

-- MRN allocation shares the gapless counter approach used for tokens.
create table mrn_counter (
  id         smallint primary key default 1,
  last_value integer not null default 0,
  constraint mrn_counter_singleton check (id = 1)
);

insert into mrn_counter (id, last_value) values (1, 0);

-- ---------------------------------------------------------------- visits

-- A Visit is the clinical/financial record. It outlives the token.
create table visit (
  id         bigint generated always as identity primary key,
  patient_id bigint      not null references patient(id),
  series_id  bigint      not null references token_series(id),
  visit_date date        not null default current_date,
  status     text        not null default 'OPEN',
  opened_at  timestamptz not null default now(),
  closed_at  timestamptz,
  constraint visit_status check (status in ('OPEN','CLOSED'))
);

create index visit_patient_idx on visit (patient_id, visit_date desc);
create index visit_open_idx    on visit (visit_date) where status = 'OPEN';

-- ---------------------------------------------------------------- tokens

create table token_counter (
  counter_date date    not null,
  series_id    bigint  not null references token_series(id),
  last_value   integer not null,
  primary key (counter_date, series_id)
);

create table token (
  id         bigint      generated always as identity primary key,
  visit_id   bigint      not null references visit(id) on delete cascade,
  series_id  bigint      not null references token_series(id),
  token_date date        not null,
  seq        integer     not null,
  display_no text        not null,            -- NORM-00042
  unique_id  text        not null unique,     -- NORM-20260805-00042
  issued_at  timestamptz not null default now(),
  issued_by  bigint      references staff(id),
  -- The real guard against duplicates. Even if the allocator were wrong,
  -- the database refuses a second token with the same number that day.
  unique (token_date, series_id, seq)
);

create index token_visit_idx on token (visit_id);
create index token_day_idx   on token (token_date, series_id);

-- ---------------------------------------------------------------- catalogue

create table service (
  id       bigint generated always as identity primary key,
  code     text   not null unique,
  name     text   not null,
  category text   not null,
  price    numeric(10,2) not null default 0,
  active   boolean not null default true,
  constraint service_category check (
    category in ('CONSULT','LAB','RADIOLOGY','PROCEDURE','OTHER')
  )
);

create index service_active_idx on service (category, name) where active;

insert into service (code, name, category, price) values
  ('CONS-GEN', 'General Consultation', 'CONSULT',    500),
  ('LAB-CBC',  'Complete Blood Count (CBC)', 'LAB',  800),
  ('LAB-BSR',  'Blood Sugar Random',  'LAB',         300),
  ('LAB-LFT',  'Liver Function Test', 'LAB',        1800),
  ('LAB-RFT',  'Renal Function Test', 'LAB',        1600),
  ('LAB-URIN', 'Urine Complete',      'LAB',         400),
  ('RAD-CXR',  'X-Ray Chest',         'RADIOLOGY',  1200),
  ('RAD-USG',  'Ultrasound Abdomen',  'RADIOLOGY',  2500),
  ('PROC-DRS', 'Dressing',            'PROCEDURE',   400),
  ('PROC-INJ', 'Injection',           'PROCEDURE',   200);

-- ---------------------------------------------------------------- ledger

-- The running visit ledger. Each item is independently PAID or PENDING so the
-- lab can collect before drawing a sample without settling the whole visit.
create table visit_item (
  id                  bigint generated always as identity primary key,
  visit_id            bigint not null references visit(id) on delete cascade,
  service_id          bigint references service(id),
  name_snapshot       text   not null,
  unit_price_snapshot numeric(10,2) not null,
  qty                 smallint not null default 1,
  discount            numeric(10,2) not null default 0,
  status              text   not null default 'PENDING',
  added_at            timestamptz not null default now(),
  added_by            bigint references staff(id),
  constraint visit_item_status check (status in ('PAID','PENDING')),
  constraint visit_item_qty check (qty > 0),
  constraint visit_item_discount check (discount >= 0)
);

create index visit_item_visit_idx on visit_item (visit_id);

-- Line total, computed once so UI and receipts can never disagree.
create or replace function visit_item_total(vi visit_item)
returns numeric language sql immutable as $$
  select greatest(vi.unit_price_snapshot * vi.qty - vi.discount, 0);
$$;

-- ---------------------------------------------------------------- invoices

-- Invoice numbers are a continuous ANNUAL series, deliberately distinct from
-- the daily token series. Auditors expect no gaps here.
create table invoice_counter (
  year       smallint primary key,
  last_value integer  not null
);

create table invoice (
  id          bigint generated always as identity primary key,
  visit_id    bigint not null references visit(id),
  invoice_no  text   not null unique,          -- INV-2026-000871
  year        smallint not null,
  seq         integer  not null,
  total       numeric(10,2) not null,
  paid        numeric(10,2) not null,
  balance     numeric(10,2) not null,
  issued_at   timestamptz not null default now(),
  issued_by   bigint references staff(id),
  voided_at   timestamptz,
  void_reason text,
  unique (year, seq)
);

create index invoice_visit_idx on invoice (visit_id);

-- ---------------------------------------------------------------- audit

-- Append-only. Under a shared login this is the entire accountability story,
-- so INSERT is the only grant it will ever receive.
create table audit_log (
  id        bigint generated always as identity primary key,
  actor     text        not null,
  action    text        not null,
  entity    text        not null,
  entity_id text,
  before    jsonb,
  after     jsonb,
  at        timestamptz not null default now()
);

create index audit_log_at_idx     on audit_log (at desc);
create index audit_log_entity_idx on audit_log (entity, entity_id);

create rule audit_log_no_update as on update to audit_log do instead nothing;
create rule audit_log_no_delete as on delete to audit_log do instead nothing;
