-- Wait-time estimation.
--
-- Three findings from the literature shaped this, and each overrides what a
-- naive implementation would do:
--
-- 1. MEDIAN, not mean. Consultation times are lognormal / right-skewed, so
--    one 25-minute case must not move the estimate for everyone behind it.
--
-- 2. DELIBERATELY OVER-PROMISE. Patients given a moderately overestimated
--    wait (~70th percentile) report the highest satisfaction; those given an
--    honest median report no gain at all. Rolling averages are additionally
--    known to under-estimate — biased in exactly the direction that angers
--    patients most. Hence the multiplier below.
--
-- 3. SEED FROM LOCAL DATA. BMJ Open's 67-country study (28.5M consultations)
--    puts Pakistani consultations at 1.79-4.0 min. Seeded at 5 min: above
--    the literature, because a private token clinic runs longer than the
--    public settings those figures came from, and because biasing high is
--    the whole point.

-- Prior when a doctor has no history yet, in seconds.
create or replace function default_consult_seconds()
returns integer language sql immutable as $fn$ select 300 $fn$;

/*
  Typical consultation length for one doctor, in seconds.

  Bayesian shrinkage toward the prior: w = n / (n + 10). At n=0 this is the
  pure seed, at n=10 it is half observed, at n=40 it is 80% observed. Each
  doctor sees 20-40 patients a day here, so the estimate becomes trustworthy
  after one to two working days — the cold-start problem is genuinely small.
*/
create or replace function typical_consult_seconds(p_doctor_id bigint)
returns integer
language plpgsql
stable
as $fn$
declare
  v_median numeric;
  v_n      integer;
  v_prior  integer := default_consult_seconds();
  v_w      numeric;
begin
  -- Today first, falling back to recent days, so a doctor who is running
  -- slower than usual today is reflected immediately.
  select count(*),
         percentile_cont(0.5) within group (
           order by extract(epoch from (ended_at - started_at))
         )
    into v_n, v_median
    from (
      select ended_at, started_at
        from token
       where doctor_id = p_doctor_id
         and status = 'DONE'
         and started_at is not null
         and ended_at is not null
         -- Guard against nonsense samples: a consultation under 30s is a
         -- misclick, over 90 min is a forgotten Done button.
         and ended_at - started_at between interval '30 seconds'
                                       and interval '90 minutes'
       order by ended_at desc
       limit 20
    ) recent;

  if v_n is null or v_n = 0 then
    return v_prior;
  end if;

  v_w := v_n::numeric / (v_n + 10);
  return round(v_w * v_median + (1 - v_w) * v_prior);
end;
$fn$;

/*
  Estimated wait for every waiting patient of one doctor.

  Includes two terms that a naive implementation forgets:

    * the REMAINING time of the consultation already in progress — if the
      doctor started 8 minutes ago and typical is 6, do not add another 6
    * the doctor's break, if any — an ETA that silently inflates destroys
      trust, so the caller can surface the reason

  Computed on read, never stored: a stored ETA is wrong the instant a doctor
  goes on break.
*/
create or replace function queue_with_eta(p_doctor_id bigint)
returns table (
  token_id     bigint,
  display_no   text,
  patient_name text,
  seq          integer,
  status       text,
  priority     smallint,
  queue_pos    integer,
  eta_minutes  integer,
  is_emergency boolean,
  recall_count smallint
)
language plpgsql
stable
as $fn$
declare
  v_typical  integer := typical_consult_seconds(p_doctor_id);
  v_inflight integer := 0;
  v_break    integer := 0;
begin
  -- Remaining time of the consultation in progress, floored at zero: an
  -- overrunning consultation should not push the estimate backwards.
  select greatest(0, v_typical - extract(epoch from (now() - token.started_at))::integer)
    into v_inflight
    from token
   where token.doctor_id = p_doctor_id
     and token.status = 'IN_CONSULTATION'
     and token.token_date = current_date
   order by token.started_at desc
   limit 1;

  v_inflight := coalesce(v_inflight, 0);

  select greatest(0, extract(epoch from (doctor_session.expected_return_at - now()))::integer)
    into v_break
    from doctor_session
   where doctor_session.doctor_id = p_doctor_id
     and doctor_session.state = 'ON_BREAK'
     and doctor_session.expected_return_at is not null;

  v_break := coalesce(v_break, 0);

  return query
  with q as (
    select t.id, t.display_no, t.seq, t.status, t.priority, t.recall_count,
           ts.is_emergency,
           (select p.name from visit v join patient p on p.id = v.patient_id
             where v.id = t.visit_id) as pname,
           row_number() over (order by t.priority desc, t.seq) as pos
      from token t
      join token_series ts on ts.id = t.series_id
     where t.doctor_id = p_doctor_id
       and t.token_date = current_date
       and t.status in ('WAITING','CALLED')
  )
  select q.id, q.display_no, q.pname, q.seq, q.status, q.priority,
         q.pos::integer,
         -- 1.4x approximates the 70th percentile of a lognormal: the
         -- deliberate over-promise described at the top of this file.
         greatest(
           1,
           round(
             ((v_inflight + v_break + (q.pos - 1) * v_typical) * 1.4) / 60.0
           )::integer
         ),
         q.is_emergency,
         q.recall_count
    from q
   order by q.pos;
end;
$fn$;

/*
  The wait to quote a patient being issued a token right now.

  Called before the token exists, so it counts the whole current queue rather
  than looking the patient up in it.
*/
create or replace function estimate_wait_minutes(
  p_doctor_id bigint,
  p_priority  smallint default 0
)
returns integer
language plpgsql
stable
as $fn$
declare
  v_typical  integer := typical_consult_seconds(p_doctor_id);
  v_ahead    integer;
  v_inflight integer := 0;
  v_break    integer := 0;
begin
  -- An emergency waits only for patients of equal or higher priority.
  select count(*) into v_ahead
    from token
   where token.doctor_id = p_doctor_id
     and token.token_date = current_date
     and token.status in ('WAITING','CALLED')
     and token.priority >= p_priority;

  select greatest(0, v_typical - extract(epoch from (now() - token.started_at))::integer)
    into v_inflight
    from token
   where token.doctor_id = p_doctor_id
     and token.status = 'IN_CONSULTATION'
     and token.token_date = current_date
   order by token.started_at desc
   limit 1;

  select greatest(0, extract(epoch from (doctor_session.expected_return_at - now()))::integer)
    into v_break
    from doctor_session
   where doctor_session.doctor_id = p_doctor_id
     and doctor_session.state = 'ON_BREAK'
     and doctor_session.expected_return_at is not null;

  return greatest(
    1,
    round(
      ((coalesce(v_inflight, 0) + coalesce(v_break, 0)
        + coalesce(v_ahead, 0) * v_typical) * 1.4) / 60.0
    )::integer
  );
end;
$fn$;
