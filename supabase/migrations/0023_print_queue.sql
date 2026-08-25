-- Print queue: let any device issue a token, and print it at the counter.
--
-- Until now the device that issued a token also printed it. That works at a
-- reception PC with the printer plugged in, and nowhere else: a tablet or a
-- phone has no COM port and never will, so a token issued on one could not
-- produce paper at all.
--
-- Splitting the two fixes that. Issuing writes a row here; the PC the printer
-- is attached to watches this queue and prints. One printer serves every
-- device in the clinic, which is also how a patient experiences it — they are
-- handed a slip at the counter regardless of what the staff tapped on.

-- PENDING once issued, PRINTED when the counter has put it on paper, FAILED
-- when the printer refused it. FAILED rather than deleting the row: a slip
-- that never printed is exactly what someone needs to find later.
-- CLAIMED is the fourth state: taken by an agent, not yet on paper. It exists
-- so a second agent polling at the same moment cannot pick up the same row.
alter table token
  add column print_status text not null default 'PENDING',
  add column printed_at   timestamptz,
  add column print_error  text,
  add constraint token_print_status
    check (print_status in ('PENDING', 'CLAIMED', 'PRINTED', 'FAILED'));

-- Rows already in the table were printed by the issuing device, back when
-- that was the only way. Marking them PENDING would make the agent reprint
-- the clinic's entire history on first run.
update token set print_status = 'PRINTED', printed_at = issued_at;

-- The agent polls for pending work constantly; everything else scans this
-- table by date. Partial, because PENDING is a handful of rows against a
-- table that grows forever.
create index token_print_pending_idx
  on token (issued_at)
  where print_status = 'PENDING';

-- Claim the oldest unprinted tokens.
--
-- `for update skip locked` is what makes a second agent safe: two counters
-- polling at once take different rows rather than both printing the same
-- slip. Without it the same token prints twice, which at a clinic counter
-- means two patients holding the same number.
create or replace function claim_pending_prints(p_limit integer default 5)
returns table (
  token_id  bigint,
  unique_id text
)
language plpgsql
as $$
begin
  return query
  with claimed as (
    select t.id
      from token t
     where t.print_status = 'PENDING'
       -- A token from a previous day is not worth printing: the patient has
       -- long gone. This also stops an agent started after a weekend from
       -- spooling out Friday's queue.
       and t.token_date = current_date
     order by t.issued_at
     limit p_limit
       for update skip locked
  )
  update token t
     set print_status = 'CLAIMED'
    from claimed c
   where t.id = c.id
  returning t.id, t.unique_id;
end;
$$;

-- Report the outcome once the bytes have actually reached the printer.
create or replace function mark_print_result(
  p_token_id bigint,
  p_ok       boolean,
  p_error    text default null
)
returns void
language sql
as $$
  update token
     set print_status = case when p_ok then 'PRINTED' else 'FAILED' end,
         printed_at   = case when p_ok then now() else null end,
         print_error  = case when p_ok then null else p_error end
   where id = p_token_id;
$$;

-- The slip's contents, rebuilt from the database.
--
-- issue_token_full() returns this shape to the issuing device, but the agent
-- prints for tokens created on a tablet that is no longer in the picture, so
-- it has to read the same thing back. The two JSON shapes are deliberately
-- identical: the agent feeds it to the same slip builder the app uses, so
-- every route prints the same paper.
create or replace function print_receipt(p_token_id bigint)
returns json
language sql
stable
as $$
  select json_build_object(
    'token_id',     t.id,
    'visit_id',     t.visit_id,
    'display_no',   t.display_no,
    'unique_id',    t.unique_id,
    'seq',          t.seq,
    'token_date',   t.token_date,
    'issued_at',    t.issued_at,
    'patient_name', p.name,
    'mrn',          p.mrn,
    'gender',       p.gender,
    'age_years',    p.age_years,
    'series_label', ts.label,
    'is_emergency', ts.is_emergency,
    'doctor_name',  d.name,
    'doctor_room',  nullif(d.room, ''),
    -- quoted_wait_min lives on the token, not the visit: it records what this
    -- particular slip told the patient, which is the number to reprint.
    'wait_minutes', t.quoted_wait_min,
    -- There is no fee column; the consultation fee is the first paid item on
    -- the visit, matching how issue_token_full() assembles it.
    'fee',          to_char(
                      coalesce((select vi.line_total
                                  from visit_item vi
                                 where vi.visit_id = t.visit_id
                                   and vi.status = 'PAID'
                                 order by vi.added_at
                                 limit 1), 0),
                      'FM999999990.00'),
    'lines',        coalesce(
                      (select json_agg(json_build_object(
                                'name',   vi.name_snapshot,
                                'amount', to_char(vi.line_total, 'FM999999990.00'))
                              order by vi.added_at)
                         from visit_item vi
                        where vi.visit_id = t.visit_id
                          and vi.status = 'PAID'),
                      '[]'::json),
    'total',        to_char(
                      coalesce((select sum(vi.line_total)
                                  from visit_item vi
                                 where vi.visit_id = t.visit_id
                                   and vi.status = 'PAID'), 0),
                      'FM999999990.00'),
    -- The tier is resolved here rather than in the agent. Duplicating the
    -- thresholds in a second language is how they drift: the agent would go
    -- on printing GOLD at the old cut-off long after src/lib/loyalty.ts moved
    -- it. Keep these in step with TIER_THRESHOLDS there.
    'tier',         (select case
                              when count(*) >= 8 then 'GOLD'
                              when count(*) >= 3 then 'REGULAR'
                              else 'NEW'
                            end
                       from visit v2
                      where v2.patient_id = v.patient_id)
  )
    from token t
    join visit v         on v.id = t.visit_id
    join patient p       on p.id = v.patient_id
    join token_series ts on ts.id = t.series_id
    left join doctor d   on d.id = v.doctor_id
   where t.id = p_token_id;
$$;

-- An agent that dies mid-job leaves a row CLAIMED forever, and that token
-- never prints. Anything held for more than two minutes is assumed abandoned
-- and returned to the queue.
create or replace function requeue_stale_prints()
returns integer
language sql
as $$
  with stale as (
    update token
       set print_status = 'PENDING'
     where print_status = 'CLAIMED'
       and issued_at < now() - interval '2 minutes'
    returning 1
  )
  select count(*)::integer from stale;
$$;
