-- Admin PIN.
--
-- The clinic runs on one shared login by choice, so this is not authentication
-- — it is a lock on the settings that change money: fees, prices, and token
-- prefixes. Reception does not know it; the owner does.
--
-- Stored as a SHA-256 hash with a per-install salt rather than in the clear,
-- so a glance at the database does not reveal it. It is a 4-6 digit PIN, so
-- the hash is not a serious defence against an offline attack — it defends
-- against the realistic threat, which is someone reading the value over a
-- shoulder or in a backup file.

/*
  pgcrypto lives in different schemas depending on the host: a plain Postgres
  install puts it in `public`, while Supabase installs it into `extensions`,
  which is NOT on the default search_path for migrations. Creating it here is
  therefore not enough on its own — the functions still resolve to nothing.

  Creating the schema (a no-op on Supabase, where it already exists) and
  putting it on the search path makes the same SQL run unmodified on both,
  which is the property that matters: these files are the deployment
  mechanism, and a migration that only works on one of the two databases is
  not a migration.
*/
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
set search_path = public, extensions;

alter table clinic_setting
  add column admin_pin_hash text,
  add column admin_pin_salt text;

-- Default PIN 1234, to be changed on first use. A NULL hash would mean
-- "no lock at all", which is a worse default than a known weak one that the
-- UI actively nags about.
update clinic_setting
   set admin_pin_salt = encode(gen_random_bytes(16), 'hex')
 where id = 1;

update clinic_setting
   set admin_pin_hash = encode(digest(admin_pin_salt || '1234', 'sha256'), 'hex')
 where id = 1;
