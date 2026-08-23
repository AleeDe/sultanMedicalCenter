/*
  Was the wait we printed on the slip honest?

  `predicted_wait_min` is what the patient was told. `started_at - issued_at`
  is what actually happened. Comparing the two is the only way to set the
  over-promise multiplier in estimate_wait_minutes() for THIS clinic instead
  of guessing it.

  The headline number is not mean error. It is the share of patients who
  waited LONGER than quoted, because that is the failure the whole design is
  arranged to avoid: an over-estimate costs nothing, an under-estimate is the
  one patients react worst to. Target is roughly 10% — pushing it to zero
  would mean quoting absurd waits to everyone.
*/

create or replace function wait_accuracy(p_days int default 30)
returns table (
  doctor_id      bigint,
  doctor_name    text,
  n              int,
  median_quoted  numeric,
  median_actual  numeric,
  median_error   numeric,   -- actual - quoted; negative = we over-promised
  over_ran_pct   numeric,   -- share who waited longer than quoted
  suggested_mult numeric
)
language sql stable as $$
  with seen as (
    select t.doctor_id,
           t.predicted_wait_min::numeric as quoted,
           extract(epoch from (t.started_at - t.issued_at)) / 60.0 as actual
      from token t
     where t.started_at is not null
       and t.predicted_wait_min is not null
       and t.issued_at > now() - make_interval(days => p_days)
       /*
         A consultation that started the next morning is a clinic that closed,
         not a queue that ran long. Those rows would swamp the median.
       */
       and t.started_at < t.issued_at + interval '6 hours'
  )
  select s.doctor_id,
         d.name,
         count(*)::int,
         round(percentile_cont(0.5) within group (order by s.quoted)::numeric, 1),
         round(percentile_cont(0.5) within group (order by s.actual)::numeric, 1),
         round(percentile_cont(0.5) within group (order by s.actual - s.quoted)::numeric, 1),
         round(100.0 * count(*) filter (where s.actual > s.quoted) / count(*), 0),
         /*
           What the multiplier would have had to be for 90% of these patients
           to be inside their quote. The current 1.4 divides out first, so this
           reads as an absolute replacement, not a further adjustment.
         */
         round(
           coalesce(
             percentile_cont(0.9) within group (order by s.actual)
               / nullif(percentile_cont(0.9) within group (order by s.quoted / 1.4), 0),
             1.4)::numeric,
           2)
    from seen s
    join doctor d on d.id = s.doctor_id
   group by s.doctor_id, d.name
  having count(*) >= 5      -- below this the median is noise
   order by count(*) desc;
$$;

comment on function wait_accuracy(int) is
  'Predicted vs actual wait per doctor. over_ran_pct is the number that matters.';
