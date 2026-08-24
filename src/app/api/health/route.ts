import { NextResponse } from "next/server";

/*
  Liveness, deliberately without touching the database.

  This answers exactly one question: can this browser reach our server? That
  is the question the offline path depends on, and it must be answerable when
  the database is down — otherwise a database fault is indistinguishable from
  a cut cable, and reception gets told to check an internet connection that
  was never the problem.

  The previous check ran `select 1`, so a rotated password or an exhausted
  connection pool reported the clinic as OFFLINE. That is worse than a plain
  error: it sends staff to the router, and it pushes the app onto its offline
  path, which then refuses to issue tokens because the leases it needs are
  themselves fetched from the server.

  Database health is a separate question, asked separately by `dbHealth()`.
*/

// Never prerendered or cached: a cached "reachable" is a lie the moment the
// server stops being reachable, and this is the one route where that matters.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// The Node runtime is not needed to answer "am I up", and the edge runtime
// answers it without waking a function that imports the database module.
export const runtime = "edge";

export function GET() {
  return NextResponse.json(
    { ok: true, at: new Date().toISOString() },
    {
      headers: {
        // Proxies and service workers must not answer this from cache.
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    },
  );
}
