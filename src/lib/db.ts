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
  Pool size.

  Supabase's session-mode pooler allows 15 client connections in total on the
  smaller compute sizes — across every machine, not per machine. A clinic runs
  reception plus a doctor tablet or two, so 10 each would exhaust it and the
  second machine would start failing to issue tokens.

  Five is comfortable for one machine's traffic (a token issue is a handful of
  statements in one transaction) and leaves room for three more clients plus
  psql. Raise it only alongside the pooler limit, never on its own.
*/
export const sql = postgres(connectionString, {
  max: Number(process.env.DB_POOL_MAX ?? 5),
  idle_timeout: 20,
  connection: {
    timezone,
    search_path: "public, extensions",
  },
});
