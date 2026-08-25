-- Break reasons, and an honest separation between the wait we CALCULATED and
-- the wait we PRINTED.

/* ------------------------------------------------------- break reasons -- */

/*
  A break already inflates every ETA in the doctor's queue. What was missing
  is the WHY: 0009 says the board "must be able to say why", but the only
  answer available was a countdown, and a number that grows without
  explanation is exactly what makes a wait feel unfair.

  Two columns, because not every reason belongs on a public screen. "Namaz"
  reassures a waiting room; "emergency case" alarms it, and a personal reason
  is nobody's business. is_public decides which the display board may show;
  reception and the doctor always see the full reason.
*/
alter table doctor_session
  add column reason      text    not null default '',
  add column is_public   boolean not null default false;

alter table doctor_session
  add constraint doctor_session_reason_len check (length(reason) <= 60);

/*
  The presets. Kept as a table rather than a CHECK constraint or a TS union so
  the clinic can add "Ward round" without a deploy, and so is_public is set
  once here instead of being decided again at every call site.
*/
create table break_reason (
  id         bigint generated always as identity primary key,
  label      text    not null unique,
  is_public  boolean not null default false,
  -- Typical length, pre-filling the minutes box. A namaz break is not a
  -- surgery, and making reception retype the usual number every time is how
  -- the field ends up left at whatever it defaulted to.
  minutes    smallint,
  active     boolean not null default true,
  sort_order smallint not null default 0
);

insert into break_reason (label, is_public, minutes, sort_order) values
  ('Namaz',          true,  15, 1),
  ('Lunch',          true,  30, 2),
  ('Tea break',      true,  10, 3),
  ('Emergency case', false, 30, 4),
  ('In surgery',     false, 60, 5),
  ('Personal',       false, 15, 6);

/* --------------------------------------------------- wait override ------ */

/*
  THE IMPORTANT ONE.

  wait_accuracy() compares predicted_wait_min against what actually happened,
  and that comparison is the only evidence for whether the 1.4x over-promise
  multiplier is right for this clinic. If reception hand-edits a wait and it
  is written back into predicted_wait_min, that row stops being a measurement
  of the ALGORITHM and becomes a measurement of a receptionist's guess —
  mixed in indistinguishably with the real samples. The suggested multiplier
  would drift and nothing would show why.

  So the two are kept apart:
    predicted_wait_min — what the algorithm said. Never overwritten.
    quoted_wait_min    — what was actually printed on the slip.

  They are equal unless someone overrode it. wait_accuracy() measures the
  first and ignores overridden rows entirely.
*/
alter table token
  add column quoted_wait_min  smallint,
  add column wait_overridden  boolean not null default false;

-- Existing tokens were never overridden, so what was printed is what was
-- predicted. Backfilled so the column is meaningful for historical rows
-- rather than a null that every reader has to special-case.
update token set quoted_wait_min = predicted_wait_min
 where predicted_wait_min is not null;

comment on column token.predicted_wait_min is
  'What estimate_wait_minutes() calculated. The measurement input for '
  'wait_accuracy(). Never overwritten by a manual override.';
comment on column token.quoted_wait_min is
  'What was actually printed on the patient''s slip. Differs from '
  'predicted_wait_min only when wait_overridden is true.';

/*
  Accuracy, now override-aware.

  Overridden rows are excluded from the tuning sample for the reason above,
  and counted separately: a rising override rate is itself the signal that
  the algorithm is wrong, which is worth seeing rather than hiding.
*/
-- Dropped rather than replaced: create or replace cannot change a function's
-- return type, and this adds override_pct to the result.
drop function if exists wait_accuracy(int);

create function wait_accuracy(p_days int default 30)
returns table (
  doctor_id      bigint,
  doctor_name    text,
  n              int,
  median_quoted  numeric,
  median_actual  numeric,
  median_error   numeric,
  over_ran_pct   numeric,
  suggested_mult numeric,
  override_pct   numeric
)
language sql stable as $$
  with all_rows as (
    select t.doctor_id, t.wait_overridden
      from token t
     where t.started_at is not null
       and t.predicted_wait_min is not null
       and t.issued_at > now() - make_interval(days => p_days)
       and t.started_at < t.issued_at + interval '6 hours'
  ),
  seen as (
    select t.doctor_id,
           t.predicted_wait_min::numeric as quoted,
           extract(epoch from (t.started_at - t.issued_at)) / 60.0 as actual
      from token t
     where t.started_at is not null
       and t.predicted_wait_min is not null
       and t.issued_at > now() - make_interval(days => p_days)
       and t.started_at < t.issued_at + interval '6 hours'
       -- The exclusion that keeps the multiplier honest.
       and not t.wait_overridden
  )
  select s.doctor_id,
         d.name,
         count(*)::int,
         round(percentile_cont(0.5) within group (order by s.quoted)::numeric, 1),
         round(percentile_cont(0.5) within group (order by s.actual)::numeric, 1),
         round(percentile_cont(0.5) within group (order by s.actual - s.quoted)::numeric, 1),
         round(100.0 * count(*) filter (where s.actual > s.quoted) / count(*), 0),
         round(
           coalesce(
             percentile_cont(0.9) within group (order by s.actual)
               / nullif(percentile_cont(0.9) within group (order by s.quoted / 1.4), 0),
             1.4)::numeric,
           2),
         coalesce((
           select round(100.0 * count(*) filter (where a.wait_overridden)
                        / nullif(count(*), 0), 0)
             from all_rows a where a.doctor_id = s.doctor_id
         ), 0)
    from seen s
    join doctor d on d.id = s.doctor_id
   group by s.doctor_id, d.name
   order by d.name;
$$;

/* ------------------------------------------------- all_queues, extended -- */

/*
  Re-declared to carry the break reason. The board and the token screen both
  read their state from this single payload (TG-07), so a reason that is not
  in here does not exist as far as the UI is concerned.

  Body is otherwise unchanged from 0017.
*/
create or replace function all_queues(p_doctor_id bigint default null)
returns json
language sql
stable
as $fn$
  select coalesce(json_agg(d order by d.sort_order, d.name), '[]'::json)
  from (
    select
      doc.id,
      doc.name,
      doc.room,
      doc.speciality,
      doc.sort_order,
      coalesce(ds.state, 'AVAILABLE') as state,
      ds.expected_return_at,
      coalesce(ds.reason, '') as break_reason,
      coalesce(ds.is_public, false) as break_reason_public,
      round(typical_consult_seconds(doc.id) / 60.0) as typical_minutes,

      -- The patient in the room right now.
      (
        select json_build_object(
          'token_id', t.id, 'display_no', t.display_no,
          'patient_name', p.name, 'started_at', t.started_at, 'status', t.status)
          from token t
          join visit v on v.id = t.visit_id
          join patient p on p.id = v.patient_id
         where t.doctor_id = doc.id
           and t.token_date = current_date
           and t.status = 'IN_CONSULTATION'
         order by t.started_at desc
         limit 1
      ) as current,

      -- Waiting + called, from the existing eta function.
      (
        select coalesce(json_agg(row_to_json(q)), '[]'::json)
          from queue_with_eta(doc.id) q
      ) as queue_rows,

      -- Skipped / no-show, recoverable.
      (
        select coalesce(json_agg(json_build_object(
                 'token_id', t.id, 'display_no', t.display_no,
                 'patient_name', p.name, 'seq', t.seq, 'status', t.status,
                 'priority', t.priority, 'queue_pos', 0, 'eta_minutes', 0,
                 'is_emergency', ts.is_emergency, 'recall_count', t.recall_count,
                 'called_at', t.called_at) order by t.seq), '[]'::json)
          from token t
          join visit v on v.id = t.visit_id
          join patient p on p.id = v.patient_id
          join token_series ts on ts.id = t.series_id
         where t.doctor_id = doc.id
           and t.token_date = current_date
           and t.status in ('SKIPPED','NO_SHOW')
      ) as skipped,

      -- Seen today.
      (
        select count(*)::int from token t
         where t.doctor_id = doc.id
           and t.token_date = current_date
           and t.status = 'DONE'
      ) as seen_today

    from doctor doc
    left join doctor_session ds on ds.doctor_id = doc.id
    where doc.active
      and (p_doctor_id is null or doc.id = p_doctor_id)
  ) d;
$fn$;
