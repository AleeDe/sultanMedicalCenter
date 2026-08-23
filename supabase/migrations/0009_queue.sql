-- Queue management, consultation timing, and doctor sign-in.
--
-- The state machine is the foundation: the wait-time estimate is only as
-- good as the timestamps behind it, and those come from reception and the
-- doctor pressing real buttons at real moments.

/*
  pgcrypto is in `extensions` on Supabase and in `public` on a plain install.
  Setting the path here covers the statements in this file; the two functions
  that hash PINs pin their own search_path, because a function body resolves
  its names when it RUNS, not when it is created.
*/
set search_path = public, extensions;

/* ------------------------------------------------------------ queue state */

alter table token add column status text not null default 'WAITING';
alter table token add column priority smallint not null default 0;
alter table token add column called_at timestamptz;
alter table token add column started_at timestamptz;
alter table token add column ended_at timestamptz;
alter table token add column recall_count smallint not null default 0;
-- What we told the patient at issue time. Stored once, immutably: it is what
-- was printed on their slip, and comparing it against the actual wait is the
-- only way to tune the estimator against this clinic rather than guess.
alter table token add column predicted_wait_min smallint;

alter table token add constraint token_status_check check (
  status in ('WAITING','CALLED','IN_CONSULTATION','DONE',
             'SKIPPED','NO_SHOW','CANCELLED')
);

/*
  SKIPPED is deliberately distinct from NO_SHOW.

  A skipped patient went to the washroom — they are recoverable, and real
  clinics recall them a few tokens later. NO_SHOW is terminal. Merging the
  two is the commonest modelling mistake here and forces reception to fight
  the software.
*/

-- The hot path is tiny (~150 rows/day) but the table grows forever, so the
-- index covers only the active states.
create index token_active_queue_idx
  on token (doctor_id, priority desc, seq)
  where status in ('WAITING','CALLED');

-- Feeds the rolling median of consultation length.
create index token_done_idx
  on token (doctor_id, ended_at desc)
  where status = 'DONE';

/* -------------------------------------------------------- doctor sign-in */

-- Same shape as the admin PIN: salted SHA-256, verified in the database so
-- the PIN never becomes a JS string that could reach a log.
alter table doctor add column pin_hash text;
alter table doctor add column pin_salt text;

update doctor
   set pin_salt = encode(gen_random_bytes(16), 'hex')
 where pin_salt is null;

-- Default 1234, and the UI nags until it is changed. A NULL hash would mean
-- "no lock at all", a worse default than a known weak one.
update doctor
   set pin_hash = encode(digest(pin_salt || '1234', 'sha256'), 'hex')
 where pin_hash is null;

create or replace function check_doctor_pin(p_doctor_id bigint, p_pin text)
returns table (ok boolean, is_default boolean)
language sql
-- Pinned, not inherited: this runs from a server action whose search_path is
-- whatever the connection pool last left it as.
set search_path = public, extensions
as $fn$
  select
    pin_hash = encode(digest(pin_salt || p_pin, 'sha256'), 'hex'),
    pin_hash = encode(digest(pin_salt || '1234', 'sha256'), 'hex')
  from doctor where id = p_doctor_id;
$fn$;

create or replace function set_doctor_pin(p_doctor_id bigint, p_pin text)
returns void
language plpgsql
set search_path = public, extensions
as $fn$
begin
  if p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'PIN must be 4 to 6 digits' using errcode = 'check_violation';
  end if;
  update doctor set pin_salt = encode(gen_random_bytes(16), 'hex')
   where id = p_doctor_id;
  update doctor
     set pin_hash = encode(digest(pin_salt || p_pin, 'sha256'), 'hex')
   where id = p_doctor_id;
end;
$fn$;

/* ------------------------------------------------------- doctor sessions */

-- Doctor availability is modelled separately from patient state: a doctor on
-- a break inflates every ETA in their queue, and the board must be able to
-- say WHY rather than silently growing the number.
create table doctor_session (
  doctor_id          bigint primary key references doctor(id) on delete cascade,
  state              text        not null default 'AVAILABLE',
  expected_return_at timestamptz,
  updated_at         timestamptz not null default now(),
  constraint doctor_session_state check (
    state in ('AVAILABLE','ON_BREAK','FINISHED')
  )
);

insert into doctor_session (doctor_id)
select id from doctor on conflict do nothing;

/* ------------------------------------------------------ queue transitions */

/*
  Calls the next patient for a doctor.

  Ordering is `priority DESC, seq ASC` — priority is the emergency lever and
  the token number is the fair tiebreak. Taken from OpenMRS's deployed queue
  module, which uses exactly this rule.

  Both reception and the doctor call this, so it must be safe under
  concurrency: FOR UPDATE SKIP LOCKED means two simultaneous callers get two
  different patients rather than both being handed the same one.
*/
create or replace function call_next(
  p_doctor_id bigint,
  p_auto_finish boolean default true
)
returns table (
  token_id     bigint,
  display_no   text,
  patient_name text,
  seq          integer
)
language plpgsql
as $fn$
begin
  /*
    Close whatever the doctor was seeing.

    Doctors forget to press Done — it is the single most common gap in clinic
    software, and every consultation time depends on it. Treating "call the
    next patient" as an implicit "finished with the last one" means the
    doctor presses one button instead of two and the data stays honest.
  */
  if p_auto_finish then
    update token
       set status = 'DONE', ended_at = now(),
           started_at = coalesce(started_at, called_at, now())
     where doctor_id = p_doctor_id
       and status = 'IN_CONSULTATION'
       and token_date = current_date;
  end if;

  /*
    Claim the row and change its status in ONE statement.

    A SELECT ... FOR UPDATE SKIP LOCKED followed by a separate UPDATE is not
    enough: both callers read the same WAITING row before either has written,
    so both are handed the same patient. Testing this concurrently is what
    exposed it — doctor and reception pressing Next at the same moment is an
    ordinary event in a clinic, not an edge case.

    The inner SELECT takes the lock and the outer UPDATE commits the status
    change atomically, so the second caller's subquery re-reads and finds the
    row no longer WAITING.
  */
  return query
  update token
     set status = 'CALLED', called_at = coalesce(token.called_at, now())
   where token.id = (
     select t.id
       from token t
      where t.doctor_id = p_doctor_id
        and t.token_date = current_date
        -- WAITING only.
        --
        -- Including CALLED here is what let two simultaneous callers land on
        -- the same patient: the first sets the row to CALLED, and the second
        -- happily picked that same row up again. A patient who has been
        -- called is already someone's responsibility; re-calling them is the
        -- Recall action, not Next.
        and t.status = 'WAITING'
      order by t.priority desc, t.seq
      for update skip locked
      limit 1
   )
  returning token.id, token.display_no,
            (select p.name from visit v join patient p on p.id = v.patient_id
              where v.id = token.visit_id),
            token.seq;
end;
$fn$;

/** Marks the consultation as actually begun — this starts the clock. */
create or replace function start_consultation(p_token_id bigint)
returns void
language sql
as $fn$
  update token
     set status = 'IN_CONSULTATION',
         started_at = coalesce(started_at, now()),
         called_at  = coalesce(called_at, now())
   where id = p_token_id;
$fn$;

/** Ends it. `ended_at - started_at` is one sample for the rolling median. */
create or replace function finish_consultation(p_token_id bigint)
returns void
language sql
as $fn$
  update token
     set status = 'DONE',
         ended_at = now(),
         started_at = coalesce(started_at, called_at, now())
   where id = p_token_id;
$fn$;

/*
  Skips a patient who did not appear.

  Returns them to the queue with a recall counter rather than sending them to
  the back: they were on time, they stepped out. Two failed recalls and they
  become a genuine NO_SHOW.
*/
create or replace function skip_token(p_token_id bigint)
returns text
language plpgsql
as $fn$
declare
  v_count smallint;
begin
  update token
     set recall_count = recall_count + 1,
         status = case when recall_count + 1 >= 2 then 'NO_SHOW' else 'SKIPPED' end,
         called_at = null
   where id = p_token_id
  returning recall_count into v_count;

  return case when v_count >= 2 then 'NO_SHOW' else 'SKIPPED' end;
end;
$fn$;

/** Puts a skipped patient back in line, at their original position. */
create or replace function recall_token(p_token_id bigint)
returns void
language sql
as $fn$
  update token set status = 'WAITING'
   where id = p_token_id and status in ('SKIPPED','NO_SHOW');
$fn$;
