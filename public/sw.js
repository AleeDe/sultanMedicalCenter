/*
  Service worker.

  Without this the offline story collapses at the first refresh: the app is
  server-rendered, so with no connection the browser gets nothing and the
  clinic is left staring at a dinosaur. Leases and outboxes are useless if
  the page cannot load to reach them.

  Strategy, chosen per resource type rather than one blanket rule:

    * navigations  — network first, fall back to the cached shell. Fresh when
                     online (so deploys land), still opens when not.
    * build assets — cache first. They are content-hashed, so a cached copy
                     is never stale.
    * server actions / POST — never touched. Those are the writes the outbox
                     is responsible for; a service worker replaying them
                     would duplicate work the outbox already owns.
*/

/*
  Bumped to v5: the announcement clips were replaced wholesale (one clip per
  whole token number became one per digit), so every board still holding the
  v4 asset cache is holding several hundred files that no longer exist. v4
  added voice caching; v3 carried the RSC fix; v2 evicted caches poisoned by
  an earlier bug, where error responses were stored as the offline shell, so
  browsers that loaded the site during a database outage kept serving that
  error back. Changing the version makes the activate handler drop the old
  caches outright, which is the only way to clear a bad entry from a browser
  we cannot reach.

  This must be bumped whenever the contents of public/voice change. A board
  runs unattended for weeks; without a bump it can keep serving a cache whose
  clips the current code no longer asks for.
*/
const VERSION = "v5";
const SHELL = `shell-${VERSION}`;
const ASSETS = `assets-${VERSION}`;

// Pages reception actually needs during an outage. Admin and analytics are
// deliberately absent — they cannot work offline anyway.
const SHELL_URLS = ["/", "/billing"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(SHELL_URLS))
      // A failed pre-cache must not block activation; the runtime cache
      // below will fill in on first visit.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => !k.endsWith(VERSION))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Writes belong to the outbox, not to the cache.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Next's build output is content-hashed, so a hit is always correct.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((res) => {
            const copy = res.clone();
            caches.open(ASSETS).then((c) => c.put(request, copy));
            return res;
          }),
      ),
    );
    return;
  }

  /*
    The announcement voice.

    Cache-first, like the build output above and for the same reason: these
    clips are rendered at build time and never change, so a hit is always
    correct. Caching them matters more than it does for most assets — the
    board is a wall-mounted screen on clinic wifi, and an announcement that
    fails because a fetch timed out is a patient who never hears their turn.

    Cached on first play rather than pre-cached. The whole vocabulary is only
    ~20 files now, so this fills up within the first few announcements of a
    day and costs nothing on a board that is already loading the page.
  */
  if (url.pathname.startsWith("/voice/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(ASSETS).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  /*
    Next's client-side navigation data. Left entirely alone.

    Clicking a link does not make a `navigate` request — Next fetches the
    route's React payload from the same URL with an `_rsc` query parameter
    and a `mode` of "cors". That fell through to the navigation branch below,
    which on failure serves cached HTML. Next then received an HTML document
    where it expected an RSC payload, could not parse it, and the navigation
    silently did nothing: the first page loaded fine and every link after it
    appeared dead.

    These are data requests, not documents. They are not useful offline —
    the pages they drive are all server-rendered from the database — so the
    correct handling is none at all, letting the network answer or fail
    honestly so Next can fall back to a full page load.
  */
  if (url.searchParams.has("_rsc") || request.headers.get("RSC") === "1") {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          /*
            Only a GOOD page is worth keeping.

            This used to cache every navigation response, errors included. A
            single 500 — a database outage, a bad deploy — was then stored as
            the offline shell and served back from cache afterwards, so the
            site stayed broken in that browser long after the server had
            recovered, and a hard reload was the only way out. An error page
            is never a useful thing to show someone offline.
          */
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(async () => {
          /*
            Match on the pathname only. A navigation to /queue must not be
            answered from an entry stored under /queue?something, and the
            fallback to "/" is a last resort for a page never visited — it
            is the app shell, which is a reasonable thing to show offline.
          */
          const cached =
            (await caches.match(request, { ignoreSearch: true })) ??
            (await caches.match("/"));
          if (cached) return cached;
          return new Response(
            "<!doctype html><meta charset=utf-8>" +
              "<body style='font:16px system-ui;padding:40px'>" +
              "<h2>Not available offline</h2>" +
              "<p>Open this page once while connected, then it will work " +
              "without internet.</p>",
            { headers: { "Content-Type": "text/html" }, status: 503 },
          );
        }),
    );
  }
});
