import "server-only";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env.local and add your " +
      "Supabase connection string (Project Settings → Database → Connection string).",
  );
}

/*
  Two settings this app cannot run correctly without:

  * timezone — current_date drives the daily token reset, so a session on UTC
    would roll the series over at 05:00 local instead of midnight.
  * search_path — pgcrypto lives in `public` on a plain Postgres install but
    in `extensions` on Supabase, and the PIN checks call digest() directly.

  These are set here AND pinned on the database itself by migration 0013.
  That is not belt-and-braces for its own sake: Supabase's connection pooler
  silently drops startup parameters, so on a pooled connection only the
  migration takes effect. Setting them here keeps a self-hosted Postgres
  correct without the migration, and costs nothing where the migration ran.

  scripts/test-db.mjs asserts the session is actually in the clinic timezone,
  because "it connected" is not the same as "it connected correctly".
*/
const timezone = process.env.CLINIC_TIMEZONE ?? "Asia/Karachi";

/*
  Pool size and prepared statements, both driven by which pooler is in use.

  Supabase offers two, and the right one depends on where this runs:

  * Session mode (5432) keeps a backend for the life of the connection. Good
    for a long-lived server, but the project is capped at ~15 client
    connections IN TOTAL across every machine.

  * Transaction mode (6543) hands back the backend between transactions, so
    thousands of short-lived clients share a small backend pool. This is what
    serverless needs: on Vercel every warm lambda holds its own pool, and a
    handful of instances would exhaust session mode outright.

  Transaction mode cannot use prepared statements, because consecutive
  statements are not guaranteed to land on the same backend. It does NOT
  break `sql.begin()` — a transaction is pinned to one backend for its whole
  duration, which is why gapless token allocation still holds. That was
  verified against the live project: 50 parallel issue_token calls through
  port 6543 produced exactly 1..50 with no duplicates.

  Detected from the port rather than configured separately, so there is one
  thing to get right in the environment instead of three.
*/
const isTransactionPooler = /:6543/.test(connectionString);

export const sql = postgres(connectionString, {
  max: Number(process.env.DB_POOL_MAX ?? (isTransactionPooler ? 3 : 5)),
  idle_timeout: 20,
  // Required by transaction pooling; harmless but pointless otherwise.
  prepare: !isTransactionPooler,
  connection: {
    timezone,
    search_path: "public, extensions",
  },
});
