// Verifies the queue state machine and the wait estimator.
//
// The estimator checks matter more than they look: research found that a
// naive average is biased toward UNDER-estimating, which is the direction
// that angers patients most, and that showing a bad estimate is no better
// than showing none. So these assert the deliberate over-promise, not just
// "a number came back".
//
// Usage: node --env-file=.env.local scripts/test-queue.mjs
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const sql = postgres(url, { max: 10, connection: { timezone: "Asia/Karachi" } });
let fail = 0;
const check = (n, ok, d = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

const tag = Date.now().toString().slice(-6);

try {
  const [doc] = await sql`
    insert into doctor (name, speciality, room, sort_order)
    values (${"Dr. Queue " + tag}, 'Test', 'Room 9', 99) returning id
  `;
  await sql`insert into doctor_session (doctor_id) values (${doc.id})
            on conflict do nothing`;
  const [series] = await sql`
    insert into token_series (code, label, base_fee, sort_order)
    values (${"QUE" + tag}, 'Queue Test', 100, 99) returning id
  `;
  const [emSeries] = await sql`
    insert into token_series (code, label, base_fee, is_emergency, sort_order)
    values (${"QEM" + tag}, 'Queue Emergency', 500, true, 99) returning id
  `;
  const [patient] = await sql`
    insert into patient (mrn, name, gender)
    values (${"TMP-" + tag}, 'Queue Test', 'OTHER') returning id
  `;

  const issue = async (seriesId, priority = 0) => {
    const [t] = await sql`
      select * from issue_token(${patient.id}, ${seriesId}, null, ${doc.id})
    `;
    if (priority) {
      await sql`update token set priority = ${priority} where id = ${t.token_id}`;
    }
    return t;
  };

  /* ------------------------------------------------------ cold start */

  const [{ typical_consult_seconds: seed }] = await sql`
    select typical_consult_seconds(${doc.id})
  `;
  check("with no history, falls back to the 5-minute seed", seed === 300,
        `${seed}s`);

  const [{ estimate_wait_minutes: first }] = await sql`
    select estimate_wait_minutes(${doc.id}, 0::smallint)
  `;
  check("first patient of the day is quoted a short wait",
        first >= 1 && first <= 3, `${first} min`);

  /* --------------------------------------------------- queue ordering */

  const t1 = await issue(series.id);
  const t2 = await issue(series.id);
  const t3 = await issue(series.id);

  let q = await sql`select * from queue_with_eta(${doc.id})`;
  check("three waiting patients appear in token order",
        q.map((r) => r.seq).join(",") === [t1.seq, t2.seq, t3.seq].join(","),
        q.map((r) => r.display_no).join(" "));
  check("positions start at 1", q[0].queue_pos === 1);
  check("later positions are quoted longer waits",
        q[2].eta_minutes > q[0].eta_minutes,
        `${q[0].eta_minutes} -> ${q[2].eta_minutes}`);

  /* ------------------------------------------ the deliberate over-promise */

  // Position 3 waits behind 2 consultations. At the 5-min seed the honest
  // figure is 10 minutes; the displayed one must exceed it.
  check("quoted wait exceeds the raw calculation (over-promise)",
        q[2].eta_minutes > 10,
        `honest 10 min, quoted ${q[2].eta_minutes} min`);
  check("but is not absurdly inflated", q[2].eta_minutes <= 20,
        `${q[2].eta_minutes} min`);

  /* -------------------------------------------------------- emergency */

  const em = await issue(emSeries.id, 10);
  q = await sql`select * from queue_with_eta(${doc.id})`;
  check("emergency jumps to the front", q[0].token_id === em.token_id,
        `${q[0].display_no} is first`);
  check("emergency is flagged so the board can explain the jump",
        q[0].is_emergency === true);
  check("everyone else keeps their relative order",
        q.slice(1).map((r) => r.seq).join(",") ===
          [t1.seq, t2.seq, t3.seq].join(","));

  /* --------------------------------------------------- call / consult */

  const [called] = await sql`select * from call_next(${doc.id})`;
  check("call_next takes the emergency first",
        called.token_id === em.token_id, called.display_no);
  check("call_next returns the patient name", Boolean(called.patient_name));

  await sql`select start_consultation(${called.token_id})`;
  const [inProg] = await sql`
    select status, started_at from token where id = ${called.token_id}
  `;
  check("start_consultation moves to IN_CONSULTATION",
        inProg.status === "IN_CONSULTATION" && inProg.started_at !== null);

  /* --------------- the forgotten Done button, the commonest real gap --- */

  const [next] = await sql`select * from call_next(${doc.id})`;
  const [autoDone] = await sql`
    select status, ended_at from token where id = ${called.token_id}
  `;
  check("calling the next patient auto-finishes the previous one",
        autoDone.status === "DONE" && autoDone.ended_at !== null,
        autoDone.status);
  check("and the next patient is now CALLED",
        next.token_id === t1.token_id, next.display_no);

  /* ---------------------------------------------------- skip / recall */

  const [{ skip_token: after1 }] = await sql`select skip_token(${next.token_id})`;
  check("first skip is recoverable, not terminal", after1 === "SKIPPED", after1);

  await sql`select recall_token(${next.token_id})`;
  q = await sql`select * from queue_with_eta(${doc.id})`;
  check("a recalled patient returns at their original position",
        q[0].token_id === next.token_id,
        `${q[0].display_no} back at position 1`);

  await sql`select skip_token(${next.token_id})`;
  const [{ skip_token: after2 }] = await sql`select skip_token(${next.token_id})`;
  check("repeated skips become a genuine NO_SHOW", after2 === "NO_SHOW", after2);

  /* --------------------------------------------------- doctor on break */

  const before = (await sql`select * from queue_with_eta(${doc.id})`)[0]
    ?.eta_minutes ?? 0;
  await sql`
    update doctor_session
       set state = 'ON_BREAK', expected_return_at = now() + interval '20 minutes'
     where doctor_id = ${doc.id}
  `;
  const during = (await sql`select * from queue_with_eta(${doc.id})`)[0]
    ?.eta_minutes ?? 0;
  check("a doctor on break inflates every ETA in that queue",
        during > before + 15, `${before} -> ${during} min`);

  await sql`
    update doctor_session set state = 'AVAILABLE', expected_return_at = null
     where doctor_id = ${doc.id}
  `;

  /* ------------------------------------ two callers, one patient each */

  await issue(series.id);
  await issue(series.id);
  const [a, b] = await Promise.all([
    sql`select * from call_next(${doc.id}, false)`,
    sql`select * from call_next(${doc.id}, false)`,
  ]);
  check("two simultaneous callers never get the same patient",
        !a[0] || !b[0] || a[0].token_id !== b[0].token_id,
        `${a[0]?.display_no ?? "-"} vs ${b[0]?.display_no ?? "-"}`);

  /* --------------------------------------- median resists one long case */

  // Seed a doctor with nine 4-minute consultations and one 60-minute one.
  const [doc2] = await sql`
    insert into doctor (name, room, sort_order)
    values (${"Dr. Median " + tag}, 'Room 8', 99) returning id
  `;
  for (let i = 0; i < 9; i++) {
    const t = await sql`
      select * from issue_token(${patient.id}, ${series.id}, null, ${doc2.id})
    `;
    await sql`
      update token set status='DONE',
             started_at = now() - interval '2 hours',
             ended_at   = now() - interval '2 hours' + interval '4 minutes'
       where id = ${t[0].token_id}
    `;
  }
  const long = await sql`
    select * from issue_token(${patient.id}, ${series.id}, null, ${doc2.id})
  `;
  await sql`
    update token set status='DONE',
           started_at = now() - interval '3 hours',
           ended_at   = now() - interval '3 hours' + interval '60 minutes'
     where id = ${long[0].token_id}
  `;

  const [{ typical_consult_seconds: med }] = await sql`
    select typical_consult_seconds(${doc2.id})
  `;
  // A mean would be ~9.6 min; the median is 4, shrunk toward the 5-min prior.
  check("one 60-minute case does not distort the estimate",
        med < 360, `${(med / 60).toFixed(1)} min (a mean would be ~9.6)`);

  // cleanup
  for (const d of [doc.id, doc2.id]) {
    await sql`delete from visit_item where visit_id in
              (select visit_id from token where doctor_id = ${d})`;
    await sql`delete from token where doctor_id = ${d}`;
    await sql`delete from visit where doctor_id = ${d}`;
    await sql`delete from doctor_session where doctor_id = ${d}`;
    await sql`delete from doctor where id = ${d}`;
  }
  await sql`delete from token_counter where series_id in (${series.id}, ${emSeries.id})`;
  await sql`delete from token_series where id in (${series.id}, ${emSeries.id})`;
  await sql`delete from patient where id = ${patient.id}`;

  console.log(fail ? `\n${fail} check(s) FAILED.\n` : "\nAll checks passed.\n");
  process.exitCode = fail ? 1 : 0;
} catch (err) {
  console.error("\nTest error:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
