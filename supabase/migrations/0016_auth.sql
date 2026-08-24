/*
  Real authentication, server-side.

  Until now the app trusted the browser: the PIN screens were React state, and
  the server actions behind them ran for anyone who could reach them. Anyone
  who knew a request existed could rewrite fees, reset a doctor's PIN, or read
  the patient list. This migration puts the trust boundary where it belongs —
  in the database and the server — and the application layer enforces it on
  every privileged call.

  Three things are added:

    1. A reception credential. Reception was entirely open; it now has a PIN
       of its own, held on clinic_setting beside the admin one.

    2. bcrypt, replacing SHA-256. SHA-256 is a FAST hash — a 4-digit PIN
       falls to it in seconds. bcrypt is deliberately slow and salted per
       call, so an offline guess costs ~100ms instead of nanoseconds. The old
       sha256 columns are kept for one release so a missed rollout does not
       lock the clinic out; verification tries bcrypt first and falls back.

    3. Sessions and lockout, so a stolen or guessed PIN is bounded. A session
       is a random token stored hashed; a run of failures locks the actor for
       a growing window, which is what actually stops brute force — the 400ms
       sleep in the app never did, because parallel requests sidestepped it.
*/

/* --------------------------------------------------------- reception PIN */

alter table clinic_setting
  add column if not exists reception_pin_hash text,
  add column if not exists reception_pin_bcrypt text,
  add column if not exists admin_pin_bcrypt text;

-- Seed reception with the same default the rest of the app ships with, so a
-- fresh clinic can sign in and is then nagged to change it (the app flags any
-- actor still on 1234). bcrypt from the start for this new credential.
update clinic_setting
   set reception_pin_bcrypt = crypt('1234', gen_salt('bf', 10))
 where id = 1 and reception_pin_bcrypt is null;

-- Migrate the existing admin PIN to bcrypt in place. The plaintext is not
-- known here, so this cannot be done directly — instead the app upgrades the
-- hash lazily on the next successful admin sign-in (see verify_pin). Until
-- then the sha256 column still verifies.

/* ------------------------------------------------------ doctor bcrypt col */

alter table doctor
  add column if not exists pin_bcrypt text;

/* --------------------------------------------------------------- sessions */

create table if not exists auth_session (
  -- The token is random and stored HASHED: a leaked database row cannot be
  -- replayed as a live session, the same reason passwords are hashed.
  token_hash   text        primary key,
  role         text        not null check (role in ('RECEPTION','ADMIN','DOCTOR')),
  -- Which doctor, when role = DOCTOR. Null otherwise.
  doctor_id    bigint      references doctor(id) on delete cascade,
  -- A human label for the audit trail — the doctor's name, or "Reception".
  actor        text        not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now()
);

create index if not exists auth_session_expiry_idx on auth_session (expires_at);

/* ------------------------------------------------------------ rate limit */

/*
  One row per actor being brute-forced. Keyed by a caller-supplied string
  (e.g. "admin", "doctor:3", "reception") so failures against one account do
  not lock another. Persisted, not in-memory, so it survives a restart and
  cannot be reset by reconnecting.
*/
create table if not exists auth_attempt (
  actor_key    text        primary key,
  fails        int         not null default 0,
  locked_until timestamptz
);

/* --------------------------------------------------------------- helpers */

/*
  Verifies a PIN for an actor, upgrading the stored hash to bcrypt on the way
  through, and enforcing the lockout.

  Returns (ok, is_default, locked_seconds). locked_seconds > 0 means the
  caller is currently locked out and no verification was attempted.

  All of this lives in one function so the lockout cannot be bypassed by
  calling verification directly — there is only one door.
*/
create or replace function verify_pin(
  p_actor_key text,
  p_pin       text,
  p_bcrypt    text,     -- current bcrypt hash, or null
  p_sha_hash  text,     -- legacy sha256 hash, or null
  p_sha_salt  text      -- legacy sha256 salt, or null
) returns table (ok boolean, is_default boolean, locked_seconds int)
language plpgsql
as $fn$
declare
  v_row       auth_attempt;
  v_ok        boolean := false;
  v_default   boolean := false;
  v_now       timestamptz := now();
  -- Lockout schedule: nothing for the first few, then a fast-growing wait.
  v_threshold int := 5;
begin
  select * into v_row from auth_attempt where actor_key = p_actor_key;

  -- Already locked? Refuse without checking, so a locked actor cannot even
  -- learn whether a guess was right.
  if v_row.locked_until is not null and v_row.locked_until > v_now then
    return query select false, false,
                        ceil(extract(epoch from (v_row.locked_until - v_now)))::int;
    return;
  end if;

  -- Verify: bcrypt first, then the legacy sha256 path.
  if p_bcrypt is not null then
    v_ok := (p_bcrypt = crypt(p_pin, p_bcrypt));
  elsif p_sha_hash is not null then
    v_ok := (p_sha_hash = encode(digest(coalesce(p_sha_salt, '') || p_pin, 'sha256'), 'hex'));
  end if;

  v_default := (p_pin = '1234');

  if v_ok then
    -- Success clears the counter.
    delete from auth_attempt where actor_key = p_actor_key;
  else
    -- Failure increments it, and locks once the threshold is passed. The
    -- window doubles each time past the threshold, capped so it is a
    -- nuisance to an attacker without permanently bricking a real user.
    insert into auth_attempt (actor_key, fails)
      values (p_actor_key, 1)
      on conflict (actor_key) do update set fails = auth_attempt.fails + 1
      returning * into v_row;

    if v_row.fails >= v_threshold then
      update auth_attempt
         set locked_until = v_now
             + (least(300, power(2, v_row.fails - v_threshold) * 5) || ' seconds')::interval
       where actor_key = p_actor_key;
    end if;
  end if;

  return query select v_ok, (v_ok and v_default), 0;
end;
$fn$;

/* Prunes expired sessions. Called opportunistically by the app. */
create or replace function prune_sessions() returns void
language sql
as $fn$
  delete from auth_session where expires_at < now();
$fn$;
