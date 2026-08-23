-- issue_token gains two offline capabilities:
--
--   p_seq        — use a specific leased number instead of drawing a new one
--   p_client_*   — client-generated UUIDs, so replaying a queued write after
--                  a flaky connection cannot create a second copy
--
-- Online callers pass neither and behave exactly as before.

create or replace function issue_token(
  p_patient_id     bigint,
  p_series_id      bigint,
  p_staff_id       bigint  default null,
  p_doctor_id      bigint  default null,
  p_seq            integer default null,
  p_client_uuid    uuid    default null,
  p_visit_uuid     uuid    default null,
  p_issued_at      timestamptz default null,
  p_lease_id       bigint  default null
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
  v_at     timestamptz := coalesce(p_issued_at, now());
  v_exists record;
begin
  /*
    Replay guard. An outbox that retries after a dropped connection must be
    safe to run twice; returning the original row is what makes the client
    free to retry without checking first.
  */
  if p_client_uuid is not null then
    select t.id, t.visit_id, t.display_no, t.unique_id, t.seq,
           t.token_date, t.issued_at
      into v_exists
      from token t where t.client_uuid = p_client_uuid;

    if found then
      return query select v_exists.id, v_exists.visit_id, v_exists.display_no,
                          v_exists.unique_id, v_exists.seq,
                          v_exists.token_date, v_exists.issued_at;
      return;
    end if;
  end if;

  select code into v_code
    from token_series where id = p_series_id and active;
  if v_code is null then
    raise exception 'Token series % is not active', p_series_id
      using errcode = 'check_violation';
  end if;

  -- An offline token was stamped on a real calendar day; honour it rather
  -- than filing yesterday's work under today.
  if p_issued_at is not null then
    v_date := (p_issued_at at time zone current_setting('TimeZone'))::date;
  end if;

  insert into visit (patient_id, series_id, visit_date, doctor_id, client_uuid)
  values (p_patient_id, p_series_id, v_date, p_doctor_id, p_visit_uuid)
  on conflict (client_uuid) where client_uuid is not null
  do update set patient_id = excluded.patient_id
  returning id into v_visit;

  -- Offline path supplies its leased number; online draws a fresh one.
  if p_seq is not null then
    v_seq := p_seq;
    if p_lease_id is not null then
      perform mark_lease_used(p_lease_id, v_seq);
    end if;
  else
    v_seq := next_token_seq(p_series_id, v_date);
  end if;

  v_disp := v_code || '-' || lpad(v_seq::text, 5, '0');
  v_uid  := v_code || '-' || to_char(v_date, 'DDMMYYYY') || '-'
                   || lpad(v_seq::text, 5, '0');

  return query
  insert into token (visit_id, series_id, token_date, seq,
                     display_no, unique_id, issued_by, doctor_id,
                     client_uuid, issued_at)
  values (v_visit, p_series_id, v_date, v_seq, v_disp, v_uid, p_staff_id,
          p_doctor_id, p_client_uuid, v_at)
  returning token.id, token.visit_id, token.display_no, token.unique_id,
            token.seq, token.token_date, token.issued_at;
end;
$$;

-- The 4-argument form is now ambiguous against the 9-argument one for calls
-- that pass exactly four arguments, so drop it — same trap as 0006.
drop function if exists issue_token(bigint, bigint, bigint, bigint);
