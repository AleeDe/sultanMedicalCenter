/*
  A doctor added after this migration ran had no PIN at all.

  0009 backfilled every doctor that existed at the time, but nothing gave a
  NEWLY created doctor a salt. `pin_salt || p_pin` is then NULL, the hash is
  NULL, and check_doctor_pin returns NULL for both columns — so the doctor can
  never sign in, and the admin screen cannot tell the clinic they are on the
  default PIN either, because the "is it 1234?" comparison is NULL rather than
  true.

  A default expression on the column is the fix rather than a trigger: it
  cannot be bypassed by an INSERT that does not mention the column, which is
  exactly how the doctor form inserts.
*/

set search_path = public, extensions;

alter table doctor
  alter column pin_salt set default encode(gen_random_bytes(16), 'hex');

/*
  The hash still has to be derived from the salt, which the column default
  cannot see. A BEFORE INSERT trigger is the only place both are in hand.
*/
create or replace function doctor_default_pin()
returns trigger
language plpgsql
set search_path = public, extensions
as $fn$
begin
  if new.pin_salt is null then
    new.pin_salt := encode(gen_random_bytes(16), 'hex');
  end if;
  if new.pin_hash is null then
    -- Same default as 0009, and the UI nags until it is changed.
    new.pin_hash := encode(digest(new.pin_salt || '1234', 'sha256'), 'hex');
  end if;
  return new;
end;
$fn$;

drop trigger if exists doctor_default_pin_trg on doctor;
create trigger doctor_default_pin_trg
  before insert on doctor
  for each row execute function doctor_default_pin();

-- Repair any doctor already created without one.
update doctor
   set pin_salt = encode(gen_random_bytes(16), 'hex')
 where pin_salt is null;

update doctor
   set pin_hash = encode(digest(pin_salt || '1234', 'sha256'), 'hex')
 where pin_hash is null;
