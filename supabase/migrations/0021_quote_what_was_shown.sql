/*
  Print the wait the patient was actually told.

  estimate_wait_minutes() runs AFTER issue_token() has created the row, so the
  new token counts itself as a patient ahead of itself and the slip prints one
  slot more than the screen showed. Reception read "7 min" at the counter and
  handed over paper saying "14-24 min".

  Two things were wrong and only one of them is the counting:

    * the screen's number was computed when the doctor was picked and went
      stale as other counters issued tokens (fixed in the form, which now
      re-reads it while open)
    * the slip recomputed from scratch at issue time, so even a fresh screen
      could disagree with the paper by one slot

  This closes the second. The estimate reception was looking at is passed in
  and printed as-is when it is present.

  It is NOT treated as an override. p_wait_shown is the algorithm's own
  number read a few seconds earlier, so wait_overridden stays false and the
  row keeps feeding wait_accuracy(). Only a hand-typed p_wait_override sets
  that flag — folding the two together would mark every token overridden and
  empty the tuning sample the multiplier depends on.

  predicted_wait_min still records what the algorithm says at issue time, so
  the accuracy tab keeps measuring the estimator rather than the screen.
*/

create or replace function issue_token_full(
  p_patient_id  bigint,
  p_series_id   bigint,
  p_staff_id    bigint  default null,
  p_doctor_id   bigint  default null,
  p_service_ids bigint[] default '{}',
  p_wait_override integer default null,
  p_actor       text    default 'Reception',
  p_wait_shown  integer default null
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

  select * into v_tok
    from issue_token(p_patient_id, p_series_id, p_staff_id, p_doctor_id);

  v_fee := v_series.base_fee;

  insert into visit_item (visit_id, service_id, name_snapshot,
                          unit_price_snapshot, qty, status, added_by)
  values (v_tok.visit_id, null, v_series.label || ' Fee', v_fee, 1, 'PAID',
          p_staff_id);

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

    -- Still recorded, still the measurement wait_accuracy() reads.
    v_predicted := estimate_wait_minutes(
      p_doctor_id, case when v_series.is_emergency then 10 else 0 end::smallint);

    v_overridden := p_wait_override is not null
                    and p_wait_override is distinct from v_predicted;

    /*
      Precedence: a hand-typed override, then what reception was shown, then
      a fresh estimate. The middle case is the ordinary one and is what stops
      the paper disagreeing with the screen.
    */
    v_quoted := coalesce(p_wait_override, p_wait_shown, v_predicted);

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
