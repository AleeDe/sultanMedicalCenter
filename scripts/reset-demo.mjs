// Clears all patient, token and billing data — run this once before the
// clinic goes live, so demo history does not mix with real records.
//
// Keeps: doctors, services, token series, clinic settings, staff, and the
// audit log (which is append-only by design and must not be erased).
//
// Usage: node --env-file=.env.local scripts/reset-demo.mjs --yes
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

if (!process.argv.includes("--yes")) {
  console.error(
    "\nThis permanently deletes every patient, token, visit and invoice.\n" +
      "Re-run with --yes if that is what you want:\n\n" +
      "  node --env-file=.env.local scripts/reset-demo.mjs --yes\n",
  );
  process.exit(1);
}

const sql = postgres(url, { max: 1 });

try {
  const [before] = await sql`
    select (select count(*) from patient)::int as patients,
           (select count(*) from token)::int   as tokens
  `;

  await sql.begin(async (tx) => {
    await tx`delete from invoice`;
    await tx`delete from visit_item`;
    await tx`delete from token`;
    await tx`delete from visit`;
    await tx`delete from token_counter`;
    await tx`delete from invoice_counter`;
    await tx`delete from patient`;
    await tx`update mrn_counter set last_value = 0 where id = 1`;
    await tx`
      insert into audit_log (actor, action, entity, entity_id)
      values ('Admin', 'RESET_DEMO_DATA', 'database', null)
    `;
  });

  console.log(
    `\nCleared ${before.patients} patients and ${before.tokens} tokens.\n` +
      "Doctors, services, token series and settings are untouched.\n" +
      "Token and MRN numbering restarts from 1.\n",
  );
} catch (err) {
  console.error("\nReset failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
