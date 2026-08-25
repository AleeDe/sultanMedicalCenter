/*
  One round trip to issue a token.

  issueToken() was making fifteen sequential round trips inside a single
  transaction — patient upsert, MRN, issue_token, series lookup, fee line,
  one INSERT PER LAB ITEM, patient re-read, visit count, audit row, doctor
  lookup, wait estimate, wait write, priority write. Against a local Postgres
  that is ~15ms and invisible. Against the Supabase pooler in Mumbai each hop
  is 40-80ms, so the same work costs roughly a second of pure network before
  any of it runs, and it grows with every lab test reception adds.

  This is the same problem 0017 solved for the queue board (TG-07), and the
  same fix: do the work set-based in the database and return everything the
  receipt needs as one JSON payload.

  The transaction boundary also gets stronger, not weaker. Fifteen statements
  from the application held a transaction open across fifteen network waits;
  one function call holds it for the duration of the function.
*/

create or replace function issue_token_full(
  p_patient_id  bigint,
  p_series_id   bigint,
  p_staff_id    bigint  default null,
  p_doctor_id   bigint  default null,
  p_service_ids bigint[] default '{}',
  p_wait_override integer default null,
  p_actor       text    default 'Reception'
)
returns json
language plpgsql
as $$
declare
  v_tok        record;
  v_series     record;
  v_patient    record;
  v_doctor     record;
  v_fee        numeric(10,2);
  v_lines      json;
  v_total      numeric(10,2);
  v_count      integer;
  v_predicted  integer;
  v_quoted     integer;
  v_overridden boolean := false;
begin
  select code, label, is_emergency, base_fee
    into v_series
    from token_series where id = p_series_id and active;
  if not found then
    raise exception 'Token series % is not active', p_series_id
      using errcode = 'check_violation';
  end if;

  -- Reuses the existing allocator rather than duplicating it: the gapless
  -- counter and the replay guard are the parts most dangerous to fork.
  select * into v_tok
    from issue_token(p_patient_id, p_series_id, p_staff_id, p_doctor_id);

  /*
    The fee is read HERE, from the series, never taken from the request —
    the same rule the row-by-row version enforced (TG-03).
  */
  v_fee := v_series.base_fee;

  insert into visit_item (visit_id, service_id, name_snapshot,
                          unit_price_snapshot, qty, status, added_by)
  values (v_tok.visit_id, null, v_series.label || ' Fee', v_fee, 1, 'PAID',
          p_staff_id);

  /*
    Every lab in ONE statement instead of one round trip each. Prices are
    still snapshotted from the catalogue inside this transaction, so a later
    price change cannot rewrite this slip.
  */
  if array_length(p_service_ids, 1) > 0 then
    insert into visit_item (visit_id, service_id, name_snapshot,
                            unit_price_snapshot, qty, status, added_by)
    select v_tok.visit_id, s.id, s.name, s.price, 1, 'PAID', p_staff_id
      from service s
     where s.id = any(p_service_ids) and s.active;
  end if;

  select json_agg(json_build_object('name', vi.name_snapshot,
                                    'amount', to_char(vi.unit_price_snapshot, 'FM999999990.00'))
                  order by vi.id),
         sum(vi.unit_price_snapshot)
    into v_lines, v_total
    from visit_item vi
   where vi.visit_id = v_tok.visit_id;

  select mrn, name, gender, age_years into v_patient
    from patient where id = p_patient_id;

  select count(*)::int into v_count
    from visit
   where patient_id = p_patient_id
     and opened_at > now() - interval '12 months';

  if p_doctor_id is not null then
    select name, room into v_doctor from doctor where id = p_doctor_id;

    v_predicted := estimate_wait_minutes(
      p_doctor_id, case when v_series.is_emergency then 10 else 0 end::smallint);

    -- What is PRINTED is the override; what is MEASURED stays the algorithm's
    -- own number, so wait_accuracy() can exclude this row from its sample.
    v_overridden := p_wait_override is not null
                    and p_wait_override is distinct from v_predicted;
    v_quoted := coalesce(p_wait_override, v_predicted);

    update token
       set predicted_wait_min = v_predicted,
           quoted_wait_min    = v_quoted,
           wait_overridden    = v_overridden,
           priority = case when v_series.is_emergency then 10 else priority end
     where id = v_tok.token_id;
  elsif v_series.is_emergency then
    update token set priority = 10 where id = v_tok.token_id;
  end if;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (p_actor, 'ISSUE_TOKEN', 'token', v_tok.token_id::text,
          json_build_object('display_no', v_tok.display_no, 'fee', v_fee,
                            'labs', coalesce(array_length(p_service_ids, 1), 0),
                            'total', v_total, 'patient', v_patient.mrn));

  return json_build_object(
    'token_id',     v_tok.token_id,
    'visit_id',     v_tok.visit_id,
    'display_no',   v_tok.display_no,
    'unique_id',    v_tok.unique_id,
    'seq',          v_tok.seq,
    'token_date',   v_tok.token_date,
    'issued_at',    v_tok.issued_at,
    'patient_name', v_patient.name,
    'mrn',          v_patient.mrn,
    'gender',       v_patient.gender,
    'age_years',    v_patient.age_years,
    'series_label', v_series.label,
    'is_emergency', v_series.is_emergency,
    'doctor_name',  v_doctor.name,
    'doctor_room',  nullif(v_doctor.room, ''),
    'wait_minutes', v_quoted,
    'fee',          to_char(v_fee, 'FM999999990.00'),
    'lines',        coalesce(v_lines, '[]'::json),
    'total',        to_char(coalesce(v_total, 0), 'FM999999990.00'),
    'visit_count',  v_count
  );
end;
$$;

/*
  Upsert a patient and return the id, so the "returning patient" and "new
  patient" paths are one trip instead of two. next_mrn() is only called when
  a row is actually created — an MRN burned on every visit would put gaps in
  a series whose whole point is not having them.
*/
create or replace function upsert_patient(
  p_id      bigint,
  p_name    text,
  p_phone   text,
  p_gender  text,
  p_age     smallint,
  p_address text
)
returns bigint
language plpgsql
as $$
declare
  v_id bigint;
begin
  if p_id is not null then
    update patient
       set name = p_name, phone = p_phone, gender = p_gender,
           age_years = p_age, address = p_address
     where id = p_id
    returning id into v_id;
    if found then return v_id; end if;
  end if;

  insert into patient (mrn, name, phone, gender, age_years, address)
  values (next_mrn(), p_name, p_phone, p_gender, p_age, p_address)
  returning id into v_id;
  return v_id;
end;
$$;
