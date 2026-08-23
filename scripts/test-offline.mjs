// Verifies the guarantees the offline path rests on. These are the checks
// that matter most in the whole system: a duplicate token number is a fight
// at the counter, and a replayed outbox that double-books is worse.
//
// Usage: node --env-file=.env.local scripts/test-offline.mjs
import postgres from "postgres";
import { randomUUID } from "node:crypto";

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
  const [series] = await sql`
    insert into token_series (code, label, base_fee, sort_order)
    values (${"OFF" + tag}, 'Offline Test', 100, 99) returning id, code
  `;
  const [patient] = await sql`
    insert into patient (mrn, name, gender)
    values (${"TMP-" + tag}, 'Offline Test', 'OTHER') returning id
  `;

  // --- a lease reserves real numbers ------------------------------------
  const [lease] = await sql`
    select * from lease_token_block(${"counter-A"}, ${series.id}, 10)
  `;
  check("lease returns a block", lease.seq_to - lease.seq_from + 1 === 10,
        `${lease.seq_from}..${lease.seq_to}`);

  // The online path must NOT reuse leased numbers. This is the guarantee.
  const [{ next_token_seq: online }] = await sql`
    select next_token_seq(${series.id}, current_date)
  `;
  check("online issue skips past the leased block", online > lease.seq_to,
        `online got ${online}, lease ended ${lease.seq_to}`);

  // --- two counters get disjoint blocks ---------------------------------
  const [a] = await sql`select * from lease_token_block('counter-A', ${series.id}, 10)`;
  const [b] = await sql`select * from lease_token_block('counter-B', ${series.id}, 10)`;
  check("two counters never overlap",
        a.seq_to < b.seq_from || b.seq_to < a.seq_from,
        `A ${a.seq_from}..${a.seq_to}  B ${b.seq_from}..${b.seq_to}`);

  // --- concurrent leases stay disjoint ----------------------------------
  const many = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      sql`select * from lease_token_block(${"c" + i}, ${series.id}, 5)`.then(r => r[0]),
    ),
  );
  const ranges = many.map(m => [m.seq_from, m.seq_to]).sort((x, y) => x[0] - y[0]);
  const overlap = ranges.some((r, i) => i > 0 && r[0] <= ranges[i - 1][1]);
  check("20 concurrent leases are all disjoint", !overlap,
        overlap ? "OVERLAP FOUND" : `${ranges.length} blocks`);

  // --- offline issue uses the leased number -----------------------------
  const uuid1 = randomUUID();
  const [t1] = await sql`
    select * from issue_token(${patient.id}, ${series.id}, null, null,
                              ${lease.seq_from}, ${uuid1}, ${randomUUID()},
                              now(), ${lease.lease_id})
  `;
  check("offline token uses the leased number", t1.seq === lease.seq_from,
        `${t1.display_no}`);

  // --- replay is idempotent — the critical one --------------------------
  const [t1again] = await sql`
    select * from issue_token(${patient.id}, ${series.id}, null, null,
                              ${lease.seq_from}, ${uuid1}, ${randomUUID()},
                              now(), ${lease.lease_id})
  `;
  check("replaying the same client_uuid returns the original",
        t1again.token_id === t1.token_id, `${t1.token_id} vs ${t1again.token_id}`);

  const [{ count: dupes }] = await sql`
    select count(*)::int as count from token where client_uuid = ${uuid1}
  `;
  check("replay created no second row", dupes === 1, `${dupes} row(s)`);

  // --- a whole outbox replayed twice ------------------------------------
  const outbox = Array.from({ length: 5 }, (_, i) => ({
    uuid: randomUUID(), visitUuid: randomUUID(), seq: lease.seq_from + 1 + i,
  }));
  const drain = () => Promise.all(outbox.map(o =>
    sql`select * from issue_token(${patient.id}, ${series.id}, null, null,
                                  ${o.seq}, ${o.uuid}, ${o.visitUuid},
                                  now(), ${lease.lease_id})`));
  await drain();
  await drain(); // the flaky-connection retry
  const [{ count: total }] = await sql`
    select count(*)::int as count from token
     where client_uuid in ${sql(outbox.map(o => o.uuid))}
  `;
  check("outbox drained twice yields 5 tokens, not 10", total === 5, `${total}`);

  // --- lease accounting -------------------------------------------------
  const [used] = await sql`
    select issued_upto, seq_from, seq_to from token_lease
     where id = ${lease.lease_id}
  `;
  check("lease records how far it was consumed",
        used.issued_upto === lease.seq_from + 5,
        `issued_upto=${used.issued_upto}`);

  const [{ release_lease: unused }] = await sql`
    select release_lease(${lease.lease_id})
  `;
  check("releasing reports the unused tail", unused === 4, `${unused} unused`);

  // --- the database still refuses a genuine duplicate -------------------
  let rejected = false;
  try {
    await sql`
      insert into token (visit_id, series_id, token_date, seq, display_no, unique_id)
      values (${t1.visit_id}, ${series.id}, current_date, ${t1.seq},
              'DUPE', ${"DUPE-" + tag})
    `;
  } catch { rejected = true; }
  check("duplicate seq still rejected by the database", rejected);

  // cleanup
  await sql`delete from visit_item where visit_id in (select id from visit where patient_id = ${patient.id})`;
  await sql`delete from token where visit_id in (select id from visit where patient_id = ${patient.id})`;
  await sql`delete from visit where patient_id = ${patient.id}`;
  await sql`delete from token_lease where series_id = ${series.id}`;
  await sql`delete from token_counter where series_id = ${series.id}`;
  await sql`delete from token_series where id = ${series.id}`;
  await sql`delete from patient where id = ${patient.id}`;

  console.log(fail ? `\n${fail} check(s) FAILED.\n` : "\nAll checks passed.\n");
  process.exitCode = fail ? 1 : 0;
} catch (err) {
  console.error("\nTest error:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
