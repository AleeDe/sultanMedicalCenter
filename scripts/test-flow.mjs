// End-to-end checks against the real database for the behaviours the plan
// calls out in §10 that a unit test cannot reach: daily reset, prefix rename
// safety, and price snapshotting.
//
// Usage: node --env-file=.env.local scripts/test-flow.mjs
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const sql = postgres(url, { max: 5, connection: { timezone: "Asia/Karachi" } });
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const tag = Date.now().toString().slice(-6);

try {
  const [series] = await sql`
    insert into token_series (code, label, base_fee, sort_order)
    values (${"FLW" + tag}, 'Flow Test', 500, 99) returning id, code
  `;
  const [patient] = await sql`
    insert into patient (mrn, name, gender)
    values (${"TMP-" + tag}, 'Flow Test', 'OTHER') returning id
  `;

  // --- daily reset -------------------------------------------------------
  // Simulated by seeding yesterday's counter, which is exactly what the live
  // system sees at midnight: the (date, series) key changes, so today starts
  // fresh with no job having to run.
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await sql`
    insert into token_counter (counter_date, series_id, last_value)
    values (${yesterday}, ${series.id}, 87)
  `;
  const [first] = await sql`select * from issue_token(${patient.id}, ${series.id}, null)`;
  check("today starts at 1 despite yesterday reaching 87", first.seq === 1,
        `seq=${first.seq}`);

  const [{ last_value: yv }] = await sql`
    select last_value from token_counter
     where counter_date = ${yesterday} and series_id = ${series.id}
  `;
  check("yesterday's counter untouched", yv === 87, `last_value=${yv}`);

  // --- prefix rename safety ---------------------------------------------
  const before = first.display_no;
  await sql`update token_series set code = ${"REN" + tag} where id = ${series.id}`;
  const [after] = await sql`select display_no from token where id = ${first.token_id}`;
  check("existing token keeps its original number after a prefix rename",
        after.display_no === before, `${before} -> ${after.display_no}`);

  const [second] = await sql`select * from issue_token(${patient.id}, ${series.id}, null)`;
  check("counter does not restart on rename", second.seq === 2, `seq=${second.seq}`);
  check("new token uses the new prefix",
        second.display_no.startsWith("REN"), second.display_no);

  // --- price snapshotting ------------------------------------------------
  const [svc] = await sql`
    insert into service (code, name, category, price)
    values (${"SVC" + tag}, 'Snapshot Test', 'LAB', 1000) returning id
  `;
  await sql`
    insert into visit_item (visit_id, service_id, name_snapshot,
                            unit_price_snapshot, qty, status)
    values (${first.visit_id}, ${svc.id}, 'Snapshot Test', 1000, 1, 'PAID')
  `;
  await sql`update service set price = 9999 where id = ${svc.id}`;
  const [item] = await sql`
    select unit_price_snapshot from visit_item
     where visit_id = ${first.visit_id} and service_id = ${svc.id}
  `;
  check("old bill unchanged after catalogue price rise",
        Number(item.unit_price_snapshot) === 1000,
        `snapshot=${item.unit_price_snapshot}`);

  // --- audit log immutability -------------------------------------------
  // Scoped to this run's entity_id: earlier runs deliberately leave their
  // probe rows behind (that is the property under test).
  const probeId = `probe-${tag}`;
  await sql`
    insert into audit_log (actor, action, entity, entity_id)
    values ('Test', 'PROBE', 'token', ${probeId})
  `;
  await sql`update audit_log set actor = 'Tampered' where entity_id = ${probeId}`;
  const [probe] = await sql`
    select actor from audit_log where entity_id = ${probeId}
  `;
  check("audit log rejects UPDATE", probe.actor === 'Test', `actor=${probe.actor}`);

  await sql`delete from audit_log where entity_id = ${probeId}`;
  const [{ count: still }] = await sql`
    select count(*)::int as count from audit_log where entity_id = ${probeId}
  `;
  check("audit log rejects DELETE", still === 1, `rows=${still}`);

  // cleanup
  await sql`delete from visit where patient_id = ${patient.id}`;
  await sql`delete from token_counter where series_id = ${series.id}`;
  await sql`delete from token_series where id = ${series.id}`;
  await sql`delete from service where id = ${svc.id}`;
  await sql`delete from patient where id = ${patient.id}`;

  console.log(failures ? `\n${failures} check(s) FAILED.\n` : "\nAll checks passed.\n");
  process.exitCode = failures ? 1 : 0;
} catch (err) {
  console.error("\nTest error:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
