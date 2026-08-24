/*
  One round trip for the whole queue board (TG-07).

  getQueues ran five queries per doctor — queue rows, the in-room patient, the
  skipped list, the typical consult time, and today's seen count — and both
  /queue and every doctor tab re-poll it every ten seconds. Against the pooler
  in Mumbai that measured ~350ms warm and ~2.2s cold per poll, all of it
  network latency multiplied by the fan-out, not query time.

  This assembles the same data for every active doctor in a single function,
  returned as one JSON array, so a poll is one round trip. The per-doctor
  logic is unchanged — it still calls queue_with_eta and typical_consult_seconds
  — it is only the round trips that collapse.

  Returns json rather than a table because the shape is nested (each doctor
  carries arrays of waiting/called/skipped rows); one json document is simpler
  to ship and parse than a flattened join the client would have to regroup.
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
