-- issue_token now carries the doctor through to both the visit and the token.
-- The allocation strategy is unchanged: the sequence is still taken inside the
-- same transaction that writes the token row, as late as possible.

create or replace function issue_token(
  p_patient_id bigint,
  p_series_id  bigint,
  p_staff_id   bigint default null,
  p_doctor_id  bigint default null
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

  insert into visit (patient_id, series_id, visit_date, doctor_id)
  values (p_patient_id, p_series_id, v_date, p_doctor_id)
  returning id into v_visit;

  v_seq  := next_token_seq(p_series_id, v_date);
  v_disp := v_code || '-' || lpad(v_seq::text, 5, '0');
  v_uid  := v_code || '-' || to_char(v_date, 'DDMMYYYY') || '-'
                   || lpad(v_seq::text, 5, '0');

  return query
  insert into token (visit_id, series_id, token_date, seq,
                     display_no, unique_id, issued_by, doctor_id)
  values (v_visit, p_series_id, v_date, v_seq, v_disp, v_uid, p_staff_id,
          p_doctor_id)
  returning token.id, token.visit_id, token.display_no, token.unique_id,
            token.seq, token.token_date, token.issued_at;
end;
$$;
