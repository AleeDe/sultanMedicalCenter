/*
  Expose called_at on the queue.

  The waiting-room board announces the patient who has just been called, and
  to do that it has to know which of the CALLED tokens is the newest one.

  More than one token can sit in CALLED at the same time: call_next() marks
  the next patient CALLED without requiring the previous one to have been
  started, so a doctor who calls twice in a row leaves two. Ordering by seq
  (which is what the queue is otherwise sorted by) then returns the OLDER of
  them, and the board would announce a patient who was called minutes ago —
  or, because that row never changes, announce nothing at all.

  called_at already exists on token; it simply was not returned here.
*/
-- Postgres cannot change a function's return type in place, and this adds a
-- column to it. Dropping first is the only route; nothing holds a reference
-- to the function across the drop because the callers are all SQL text.
drop function if exists queue_with_eta(bigint);

create function queue_with_eta(p_doctor_id bigint)
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
  recall_count smallint,
  called_at    timestamptz
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
           t.called_at,
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
         q.recall_count,
         q.called_at
    from q
   order by q.pos;
end;
$fn$;
