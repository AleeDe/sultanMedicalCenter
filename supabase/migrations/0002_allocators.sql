-- Gapless number allocation.
--
-- All three allocators use the same trick: an upsert whose DO UPDATE takes a
-- row lock, with RETURNING handing back the new value in the same statement.
-- Concurrent callers block on the row rather than racing. No advisory lock,
-- no retry loop, no cron job that can be late.
--
-- Callers MUST invoke these inside the transaction that inserts the owning
-- row, as late as possible: a rolled-back transaction still burns a number.

-- Next token number for a series on a given day.
-- Daily reset is implicit in the counter_date key — nothing has to run at
-- midnight, so nothing can fail to run at midnight.
create or replace function next_token_seq(p_series_id bigint, p_date date)
returns integer
language sql
as $$
  insert into token_counter (counter_date, series_id, last_value)
  values (p_date, p_series_id, 1)
  on conflict (counter_date, series_id)
  do update set last_value = token_counter.last_value + 1
  returning last_value;
$$;

create or replace function next_invoice_seq(p_year smallint)
returns integer
language sql
as $$
  insert into invoice_counter (year, last_value)
  values (p_year, 1)
  on conflict (year)
  do update set last_value = invoice_counter.last_value + 1
  returning last_value;
$$;

create or replace function next_mrn()
returns text
language sql
as $$
  update mrn_counter
     set last_value = last_value + 1
   where id = 1
  returning 'MRN-' || lpad(last_value::text, 6, '0');
$$;

-- Issue a token: allocates the number and writes visit + token atomically.
-- Everything a receipt needs comes back in one round trip, because the
-- patient is standing at the counter while this runs.
create or replace function issue_token(
  p_patient_id bigint,
  p_series_id  bigint,
  p_staff_id   bigint default null
)
returns table (
  token_id    bigint,
  visit_id    bigint,
  display_no  text,
  unique_id   text,
  seq         integer,
  token_date  date,
  issued_at   timestamptz
)
language plpgsql
as $$
declare
  v_date   date := current_date;
  v_code   text;
  v_seq    integer;
  v_visit  bigint;
  v_disp   text;
  v_uid    text;
begin
  select code into v_code
    from token_series
   where id = p_series_id and active;

  if v_code is null then
    raise exception 'Token series % is not active', p_series_id
      using errcode = 'check_violation';
  end if;

  insert into visit (patient_id, series_id, visit_date)
  values (p_patient_id, p_series_id, v_date)
  returning id into v_visit;

  -- Allocated last, so the lock is held for the shortest possible window.
  v_seq  := next_token_seq(p_series_id, v_date);
  v_disp := v_code || '-' || lpad(v_seq::text, 5, '0');
  v_uid  := v_code || '-' || to_char(v_date, 'DDMMYYYY') || '-'
                   || lpad(v_seq::text, 5, '0');

  return query
  insert into token (visit_id, series_id, token_date, seq,
                     display_no, unique_id, issued_by)
  values (v_visit, p_series_id, v_date, v_seq, v_disp, v_uid, p_staff_id)
  returning token.id, token.visit_id, token.display_no, token.unique_id,
            token.seq, token.token_date, token.issued_at;
end;
$$;
