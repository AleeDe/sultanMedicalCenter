// Verification for plan §10: the token allocator must be gapless and
// duplicate-free under concurrent load. This is the one piece that is hard to
// fix after the fact, so it is tested before any UI exists.
//
// Usage: node --env-file=.env.local scripts/test-concurrency.mjs
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. See .env.example.");
  process.exit(1);
}

const PARALLEL = 50;
/*
  50 requests over 10 connections, not 50 over 50.

  The contention being tested is for the counter ROW, not for sockets, and
  queueing the requests through a smaller pool exercises it just as hard.
  Supabase's session-mode pooler caps a project at 15 client connections in
  total, so a pool of 20 fails to connect before it ever reaches the
  allocator — testing the pooler instead of the code.
*/
const sql = postgres(url, {
  max: Number(process.env.DB_POOL_MAX ?? 10),
  connection: { timezone: "Asia/Karachi" },
});
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

try {
  // Isolated fixtures so the test never pollutes real clinic data.
  const [series] = await sql`
    insert into token_series (code, label, base_fee, sort_order)
    values (${"TEST" + Date.now().toString().slice(-6)}, 'Concurrency Test', 0, 99)
    returning id, code
  `;
  const [patient] = await sql`
    insert into patient (mrn, name, gender)
    values (${"TMP-" + Date.now()}, 'Concurrency Test', 'OTHER')
    returning id
  `;

  console.log(`\nFiring ${PARALLEL} parallel token requests...\n`);

  const results = await Promise.all(
    Array.from({ length: PARALLEL }, () =>
      sql`select * from issue_token(${patient.id}, ${series.id}, null)`.then(
        (r) => r[0],
      ),
    ),
  );

  const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
  const expected = Array.from({ length: PARALLEL }, (_, i) => i + 1);

  check(
    "no duplicate sequence numbers",
    new Set(seqs).size === PARALLEL,
    `${PARALLEL - new Set(seqs).size} duplicate(s)`,
  );
  check(
    `gapless 1..${PARALLEL}`,
    JSON.stringify(seqs) === JSON.stringify(expected),
    `got ${seqs[0]}..${seqs[seqs.length - 1]}`,
  );
  check(
    "display numbers zero-padded and unique",
    new Set(results.map((r) => r.display_no)).size === PARALLEL &&
      results.every((r) => /^[A-Z0-9]+-\d{5}$/.test(r.display_no)),
  );
  check(
    "internal unique ids carry the date",
    results.every((r) => /^[A-Z0-9]+-\d{8}-\d{5}$/.test(r.unique_id)),
    results[0]?.unique_id,
  );

  // A second series must count independently, not share the counter.
  const [other] = await sql`
    insert into token_series (code, label, base_fee, sort_order)
    values (${"TST2" + Date.now().toString().slice(-6)}, 'Second Series', 0, 99)
    returning id
  `;
  const [firstOfOther] = await sql`
    select * from issue_token(${patient.id}, ${other.id}, null)
  `;
  check(
    "second series starts its own count at 1",
    firstOfOther.seq === 1,
    `seq=${firstOfOther.seq}`,
  );

  // The unique constraint must reject a duplicate even if a caller bypasses
  // the allocator entirely — defence in depth behind the counter table.
  let rejected = false;
  try {
    await sql`
      insert into token (visit_id, series_id, token_date, seq, display_no, unique_id)
      values (${results[0].visit_id}, ${series.id}, ${results[0].token_date},
              ${results[0].seq}, 'DUPE-00001', ${"DUPE-" + Date.now()})
    `;
  } catch {
    rejected = true;
  }
  check("database rejects a hand-inserted duplicate seq", rejected);

  // Cleanup: visits cascade to tokens.
  await sql`delete from visit where patient_id = ${patient.id}`;
  await sql`delete from token_counter where series_id in (${series.id}, ${other.id})`;
  await sql`delete from token_series where id in (${series.id}, ${other.id})`;
  await sql`delete from patient where id = ${patient.id}`;

  console.log(
    failures ? `\n${failures} check(s) FAILED.\n` : "\nAll checks passed.\n",
  );
  process.exitCode = failures ? 1 : 0;
} catch (err) {
  console.error("\nTest error:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
