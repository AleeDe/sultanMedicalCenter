/*
  Is this database actually usable, not merely reachable?

  Run after pointing DATABASE_URL at a new host, before the first real token:

    node --env-file=.env.production.local scripts/test-db.mjs

  Every check here corresponds to something that succeeded on a developer
  laptop and failed on Supabase. "It connected" is not the same as "it
  connected correctly", and both of the differences below are invisible until
  a patient is standing at the counter.
*/
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const want = process.env.CLINIC_TIMEZONE ?? "Asia/Karachi";
const sql = postgres(url, { max: 2, idle_timeout: 10 });

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

try {
  /* ------------------------------------------------------------ session --- */

  const [s] = await sql`
    select current_setting('TimeZone') as tz,
           current_database() as db,
           current_date::text as today
  `;

  /*
    The one that matters most. Supabase's pooler discards startup parameters,
    so a session can silently sit on UTC — and current_date drives the daily
    token reset. On UTC the series rolls over at 05:00 local, mid-morning.
  */
  check("the session is in the clinic timezone", s.tz === want,
        `${s.tz}${s.tz === want ? "" : ` (expected ${want}) — is migration 0013 applied?`}`);

  const local = new Date().toLocaleDateString("en-CA", { timeZone: want });
  check("current_date matches today in the clinic", s.today === local,
        `db says ${s.today}, clinic is ${local}`);

  /* ---------------------------------------------------------- pgcrypto --- */

  // Lives in `extensions` on Supabase and `public` elsewhere. The PIN checks
  // call these directly, so a bad search_path throws at sign-in time.
  const [c] = await sql`
    select encode(digest('x', 'sha256'), 'hex') as h,
           length(encode(gen_random_bytes(16), 'hex')) as n
  `;
  check("pgcrypto resolves on the search path", c.h.length === 64 && c.n === 32);

  /* ----------------------------------------------------------- schema ---- */

  const tables = (
    await sql`
      select table_name from information_schema.tables
       where table_schema = 'public'
    `
  ).map((r) => r.table_name);

  for (const t of ["patient", "visit", "token", "service", "visit_item",
                   "invoice", "audit_log", "doctor", "token_lease",
                   "doctor_session"]) {
    check(`table ${t}`, tables.includes(t));
  }

  const fns = (
    await sql`
      select routine_name from information_schema.routines
       where routine_schema = 'public'
    `
  ).map((r) => r.routine_name);

  for (const f of ["issue_token", "next_token_seq", "next_invoice_seq",
                   "next_mrn", "call_next", "start_consultation",
                   "finish_consultation", "estimate_wait_minutes",
                   "wait_accuracy", "check_doctor_pin", "set_doctor_pin"]) {
    check(`function ${f}()`, fns.includes(f));
  }

  /* ------------------------------------------------------- append-only --- */

  // The audit log is the entire accountability story under a shared login.
  await sql`
    insert into audit_log (actor, action, entity, entity_id)
    values ('test-db', 'PROBE', 'probe', '0')
  `;
  await sql`update audit_log set actor = 'tampered' where actor = 'test-db'`;
  const [{ n: tampered }] = await sql`
    select count(*)::int as n from audit_log where actor = 'tampered'
  `;
  check("the audit log ignores UPDATE", tampered === 0);

  await sql`delete from audit_log where actor = 'test-db'`;
  const [{ n: left }] = await sql`
    select count(*)::int as n from audit_log where actor = 'test-db'
  `;
  check("the audit log ignores DELETE", left > 0, `${left} probe row(s) remain`);

  /* ------------------------------------------------------ doctor PINs ---- */

  const withoutPin = await sql`
    select name from doctor where active and (pin_salt is null or pin_hash is null)
  `;
  check("every doctor has a PIN set", withoutPin.length === 0,
        withoutPin.map((d) => d.name).join(", ") || "all set");

  const defaults = await sql`
    select name from doctor
     where active and pin_hash = encode(digest(pin_salt || '1234', 'sha256'), 'hex')
  `;
  // Not a failure — the clinic has not gone live yet — but it must be said.
  console.log(
    defaults.length === 0
      ? "  PASS  no doctor is on the default PIN"
      : `  WARN  ${defaults.length} doctor(s) still on PIN 1234: ${defaults
          .map((d) => d.name)
          .join(", ")}`,
  );

  console.log(fail ? `\n${fail} FAILED` : "\nDatabase is ready.");
} catch (err) {
  console.error("\nFAILED:", err.message);
  fail++;
} finally {
  await sql.end();
}

process.exit(fail ? 1 : 0);
