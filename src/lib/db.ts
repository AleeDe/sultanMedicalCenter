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
/*
  The port, read by parsing the URL rather than pattern-matching the string.

  Two regexes over the raw string used to answer this — one for "is it 6543",
  another to name the port in the error — and they could disagree, producing
  the self-contradicting "points at port 6543, but requires port 6543".
  Worse, a substring match also finds 6543 inside the PASSWORD, so a session
  connection whose password happened to contain those digits was silently
  treated as the transaction pooler.

  One parse, one answer. The trim/unquote guards against a value pasted into
  a dashboard with stray whitespace or quotation marks around it.
*/
const dbPort = (() => {
  try {
    return new URL(connectionString.trim().replace(/^["']|["']$/g, "")).port;
  } catch {
    // An unparseable URL is postgres's problem to report, not this check's.
    return "";
  }
})();

const isTransactionPooler = dbPort === "6543";

/*
  A serverless host on the session pooler will fail under any real traffic:
  every warm instance holds its own pool against a ~15-connection cap, so
  requests start returning EMAXCONNSESSION as soon as a second instance warms
  up. It looks fine in one-off testing and breaks the moment two people use
  it at once.

  This shipped to production once already, so it still refuses to serve
  traffic on the wrong pooler. Two things it deliberately does NOT do:

  * It does not fail the BUILD. `next build` imports every route to read its
    config, which evaluates this module — so throwing here killed the build
    over a value that only matters once a request is served. A deployment
    that cannot build also cannot be repaired by fixing an environment
    variable and redeploying, which is exactly the fix this error asks for.
    It now warns during the build and throws on first use instead.

  * It does not assert a port it never checked. The original message named
    5432 as fact, which sent people back to re-read a variable that was
    sometimes already correct. It reports the port actually found.
*/

/* Set by `next build` while collecting route config; unset at runtime. */
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

if (process.env.VERCEL && !isTransactionPooler) {
  const message =
    `DATABASE_URL points at port ${dbPort || "(none)"}, but serverless ` +
    "requires Supabase's transaction pooler on port 6543. " +
    "Update DATABASE_URL in the Vercel " +
    "project's environment variables (Settings -> Environment Variables), " +
    "tick the Production environment, then redeploy WITHOUT the build cache " +
    "-- a cached build keeps the old value. See README, 'Which pooler'.";

  if (isBuildPhase) {
    // Visible in the build log, but the deployment still completes so the
    // fix can be applied by changing the variable and redeploying.
    console.warn(`[db] WARNING: ${message}`);
  } else {
    throw new Error(message);
  }
}

export const sql = postgres(connectionString, {
  max: Number(process.env.DB_POOL_MAX ?? (isTransactionPooler ? 3 : 5)),

  /*
    Short idle timeout on serverless. A lambda is frozen between requests
    rather than shut down, so a long-lived idle connection stays counted
    against the project's cap by an instance that may never serve another
    request. Returning it quickly costs little: the pooler keeps the backend
    warm, so reconnecting is cheap.
  */
  idle_timeout: isTransactionPooler ? 5 : 20,
  // Required by transaction pooling; harmless but pointless otherwise.
  prepare: !isTransactionPooler,
  connection: {
    timezone,
    search_path: "public, extensions",
  },
});
