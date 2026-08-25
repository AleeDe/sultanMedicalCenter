-- MRN format change: MRN-000451 -> BT-260825-0417
--
-- Why the format changed: reception reads the MRN off a crumpled slip and
-- types it while a queue waits. A date-prefixed number tells them at a glance
-- when the patient first registered, which is the one fact that helps them
-- confirm they have the right person before committing.
--
-- What is deliberately NOT in it: phone and gender. Both change (SIM swap,
-- a mis-tapped M) and an MRN that changes is not an identity. Registration
-- date cannot change after the fact, so it is safe to embed.
--
-- Existing MRNs are NOT rewritten. They are printed on slips, bills and lab
-- reports already in patients' hands. The two formats coexist permanently;
-- that is correct, not a migration left half-done.

-- Daily-reset counter, mirroring token_counter. A running total would outgrow
-- four digits inside a year and make the date prefix redundant.
create table mrn_counter_day (
  counter_date date    primary key,
  last_value   integer not null
);

-- The old singleton counter stays: it is the audit trail for how many MRNs
-- the pre-2026-08-25 format issued, and dropping it would strand that.
comment on table mrn_counter is
  'Superseded by mrn_counter_day. Retained as the record of the MRN-NNNNNN series.';

-- Prefix lives in clinic_setting so a second branch can issue BT-/CT- without
-- a code change. Constrained to letters so an MRN can never grow a separator
-- that breaks parsing.
alter table clinic_setting
  add column mrn_prefix text not null default 'BT';

alter table clinic_setting
  add constraint clinic_setting_mrn_prefix
  check (mrn_prefix ~ '^[A-Z]{1,4}$');

/*
  Allocation is a single upsert-returning, exactly like next_token_seq: the
  row lock is held for the duration of the statement, so two receptionists
  registering at the same instant serialise instead of colliding. Doing this
  as select-then-update would race.

  Timezone matters here. The counter must roll over at local midnight, not
  UTC — a patient registered at 2am Karachi belongs to that day's series.
  set timezone at the top of 0001 makes current_date local already; this is
  explicit so a future session-level change cannot silently shift the series.
*/
create or replace function next_mrn()
returns text
language sql
as $$
  with d as (
    select (now() at time zone 'Asia/Karachi')::date as today
  ),
  bump as (
    insert into mrn_counter_day (counter_date, last_value)
    select today, 1 from d
    on conflict (counter_date)
    do update set last_value = mrn_counter_day.last_value + 1
    returning counter_date, last_value
  )
  select (select mrn_prefix from clinic_setting where id = 1)
      || '-' || to_char(bump.counter_date, 'YYMMDD')
      || '-' || lpad(bump.last_value::text, 4, '0')
    from bump;
$$;

-- Search support -----------------------------------------------------------

-- MRN lookup is the hot path for a returning patient holding their slip.
-- Case-insensitive because reception types 'bt-260825-0417' as often as not.
create index patient_mrn_lower_idx on patient (lower(mrn));

/*
  Name search needs to survive the way names are actually typed here:
  "Muhammad Aslam" / "muhammad aslam" / "M. Aslam". trigram similarity handles
  the spelling drift that a tsvector match does not — 'Mohammad' vs
  'Muhammad' shares enough trigrams to rank, while to_tsvector treats them as
  two unrelated lexemes.
*/
create extension if not exists pg_trgm;
create index patient_name_trgm_idx on patient using gin (name gin_trgm_ops);
